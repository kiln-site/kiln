/**
 * Artifacts this Relay pulls from other Relays. Hearth starts a pull with
 * `transfer.pull.start`; the Relay fetches the artifact into a part file,
 * resuming from what it already has after a dropped connection or a
 * restart, checks its SHA-256 against the grant, then installs it under the
 * target root in the root's lanes.
 */
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Clock, Effect, Fiber, Schedule, Schema, Semaphore } from "effect"

import {
  RelayPeerEndpointSchema,
  RelayPeerTransferGrantSchema,
  RelayTransferPullSchema,
  type RelayPeerEndpoint,
  type RelayTransferPull,
  type RelayTransferPullStart,
  type RelayTransferReference,
} from "@workspace/contracts"

import type { RelayIdentity } from "../../effect/identity.js"
import type { OperationLanes } from "../../operation-lanes.js"
import { fetchArtifactRange, PeerFetchError } from "./client.js"
import {
  ensureTransferDirectory,
  readTransferRecords,
  removeTransferFiles,
  writeTransferRecord,
} from "./manifests.js"
import type { TransferRootResolver } from "./roots.js"

// How long a finished pull's record is kept for Hearth to read.
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000
// Progress is written down at most this often while bytes arrive.
const PROGRESS_INTERVAL_MS = 5_000
// Attempts after the first, backing off from a second to about two minutes
// apart, so a source that's down for a few minutes is waited out.
const RETRIES = 8

// What the Relay keeps for a pull: what Hearth reads, and what it needs to
// resume it.
const PullRecordSchema = Schema.Struct({
  pull: RelayTransferPullSchema,
  audience: Schema.String,
  endpoints: Schema.Array(RelayPeerEndpointSchema),
  grant: Schema.String,
  sha256: Schema.String,
})
type PullRecord = typeof PullRecordSchema.Type

export interface TransferPullsOptions {
  /** Where part files and records are kept. */
  readonly directory: string
  readonly identity: RelayIdentity
  readonly lanes: OperationLanes
  readonly resolveRoot: TransferRootResolver
  /** When to fetch again after a failure that may pass. */
  readonly retrySchedule?: Schedule.Schedule<unknown>
}

export class TransferPulls {
  readonly #options: TransferPullsOptions
  readonly #records = new Map<string, PullRecord>()
  readonly #running = new Map<string, Fiber.Fiber<void>>()
  readonly #savedAt = new Map<string, number>()
  // One write of a transfer's record at a time, so a slow progress write
  // can't land after, and undo, the one that finished it.
  readonly #saving = new Map<string, Semaphore.Semaphore>()

  constructor(options: TransferPullsOptions) {
    this.#options = options
  }

  /**
   * Loads the pulls of a previous run and resumes those still fetching. One
   * that was installing may have left part of its files behind, so it fails
   * rather than installing over them.
   */
  load() {
    return Effect.gen({ self: this }, function* () {
      const records = yield* readTransferRecords(
        this.#options.directory,
        PullRecordSchema
      )
      const now = yield* Clock.currentTimeMillis
      for (const record of records) {
        const { pull } = record
        if (
          finished(pull.state) &&
          pull.updatedAt + FINISHED_RETENTION_MS <= now
        ) {
          yield* removeTransferFiles(this.#options.directory, pull.transferId)
          continue
        }
        this.#records.set(pull.transferId, record)
        if (pull.state === "installing") {
          yield* this.#update(pull.transferId, {
            error:
              "The Relay restarted while installing this transfer; its destination may hold part of it",
            state: "failed",
          })
        } else if (pull.state === "pulling" || pull.state === "verifying") {
          yield* this.#run(pull.transferId)
        }
      }
    }).pipe(Effect.withSpan("RelayTransfer.loadPulls"))
  }

  /**
   * Starts a pull, or returns the one already under this transfer ID. A
   * failed or cancelled pull starts again, resuming from what it fetched.
   */
  start(input: RelayTransferPullStart) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({
        "kiln.transfer.id": input.transferId,
        "kiln.file_root.id": input.target.rootId,
      })
      const grant = yield* decodeGrant(input.grant)
      if (
        grant.transferId !== input.transferId ||
        grant.peer !== this.#options.identity.fingerprint
      ) {
        return yield* Effect.fail(
          new Error("The transfer grant is for another Relay or transfer")
        )
      }
      const existing = this.#records.get(input.transferId)
      if (existing) {
        if (
          existing.pull.target.rootId !== input.target.rootId ||
          existing.pull.target.path !== input.target.path ||
          existing.sha256 !== grant.sha256
        ) {
          return yield* Effect.fail(
            new Error("This transfer ID is already used for another pull")
          )
        }
        if (
          existing.pull.state !== "failed" &&
          existing.pull.state !== "cancelled"
        ) {
          return existing.pull
        }
      }
      // The target must exist before anything is fetched for it.
      yield* Effect.tryPromise(() =>
        this.#options.resolveRoot(input.target.rootId)
      )
      const now = yield* Clock.currentTimeMillis
      const record: PullRecord = {
        audience: grant.audience,
        endpoints: input.endpoints,
        grant: input.grant,
        pull: {
          createdAt: existing?.pull.createdAt ?? now,
          endpoint: null,
          error: null,
          receivedBytes: yield* this.#partSize(input.transferId),
          size: grant.size,
          state: "pulling",
          target: input.target,
          transferId: input.transferId,
          updatedAt: now,
        },
        sha256: grant.sha256,
      }
      yield* ensureTransferDirectory(this.#options.directory)
      yield* this.#save(record)
      yield* this.#run(input.transferId)
      return record.pull
    }).pipe(Effect.withSpan("RelayTransfer.startPull"))
  }

  get(reference: RelayTransferReference): RelayTransferPull | null {
    const record = this.#records.get(reference.transferId)
    return record && record.pull.target.rootId === reference.rootId
      ? record.pull
      : null
  }

  /**
   * Stops a pull that hasn't started installing and deletes what it
   * fetched, including what a failed one kept to resume from. One already
   * installing finishes, since stopping it halfway would leave part of its
   * files behind.
   */
  cancel(reference: RelayTransferReference) {
    return Effect.gen({ self: this }, function* () {
      const pull = this.get(reference)
      if (!pull) return null
      if (
        pull.state !== "pulling" &&
        pull.state !== "verifying" &&
        pull.state !== "failed"
      ) {
        return pull
      }
      const running = this.#running.get(pull.transferId)
      if (running) yield* Fiber.interrupt(running)
      yield* this.#removePart(pull.transferId)
      return yield* this.#update(pull.transferId, {
        error: null,
        state: "cancelled",
      })
    }).pipe(Effect.withSpan("RelayTransfer.cancelPull"))
  }

  #run(transferId: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.#running.has(transferId)) return
      const fiber = yield* this.#pull(transferId).pipe(
        Effect.ensuring(Effect.sync(() => this.#running.delete(transferId))),
        Effect.forkDetach
      )
      this.#running.set(transferId, fiber)
    })
  }

  #pull(transferId: string) {
    const options = this.#options
    return Effect.gen({ self: this }, function* () {
      const record = this.#records.get(transferId)
      if (!record) return
      yield* Effect.annotateCurrentSpan({
        "kiln.file_root.id": record.pull.target.rootId,
        "kiln.transfer.bytes": record.pull.size,
      })
      if (record.pull.state === "pulling") {
        yield* this.#fetch(record).pipe(
          // Shown while it waits to try again, so a pull that can't reach
          // its source says why.
          Effect.tapError((error) =>
            this.#update(transferId, {
              error: `Retrying: ${errorMessage(error)}`,
            }).pipe(Effect.ignore)
          ),
          Effect.retry({
            schedule: options.retrySchedule ?? Schedule.exponential("1 second"),
            times: RETRIES,
            while: (error) =>
              !(error instanceof PeerFetchError) || error.retryable,
          })
        )
        yield* this.#update(transferId, { error: null, state: "verifying" })
      }
      const digest = yield* hashFile(this.#partPath(transferId))
      if (digest !== record.sha256) {
        yield* this.#removePart(transferId)
        return yield* Effect.fail(
          new Error("The transfer didn't match its digest; it was discarded")
        )
      }
      yield* this.#update(transferId, { state: "installing" })
      const target = yield* Effect.tryPromise(() =>
        options.resolveRoot(record.pull.target.rootId)
      )
      yield* options.lanes.run(
        { label: "transfer.pull.install", locks: target.installLocks },
        target.filesystem.installTransferArchive(
          target.root,
          record.pull.target.path,
          this.#partPath(transferId)
        )
      )
      yield* this.#removePart(transferId)
      yield* this.#update(transferId, { error: null, state: "completed" })
    }).pipe(
      Effect.catch((cause) =>
        this.#update(transferId, {
          error: errorMessage(cause),
          state: "failed",
        }).pipe(Effect.asVoid)
      ),
      Effect.catchCause(() => Effect.void),
      Effect.withSpan("RelayTransfer.pull", {
        attributes: { "kiln.transfer.id": transferId },
      })
    )
  }

  // One attempt: fetches what's missing through the first endpoint that
  // answers, appending it to the part file.
  #fetch(record: PullRecord) {
    const options = this.#options
    const transferId = record.pull.transferId
    return Effect.gen({ self: this }, function* () {
      let lastError: PeerFetchError | null = null
      // The record as it is now, with the endpoint that last answered.
      const current = this.#records.get(transferId) ?? record
      for (const endpoint of orderedEndpoints(current)) {
        // Read again for each endpoint: one that failed partway may have
        // added to the part.
        const offset = yield* this.#partSize(transferId)
        yield* this.#update(transferId, { receivedBytes: offset })
        if (offset === record.pull.size) return
        if (offset > record.pull.size) {
          yield* this.#removePart(transferId)
          return yield* new PeerFetchError({
            reason: "The part already fetched is larger than the transfer",
            retryable: true,
          })
        }
        const fetched = yield* Effect.scoped(
          Effect.gen({ self: this }, function* () {
            const response = yield* fetchArtifactRange({
              audience: record.audience,
              endpoint,
              grant: record.grant,
              identity: options.identity,
              offset,
              transferId,
            })
            if (response.total !== record.pull.size) {
              return yield* new PeerFetchError({
                reason:
                  "The source Relay's artifact isn't the size its grant names",
                retryable: false,
              })
            }
            yield* this.#update(transferId, { endpoint: endpoint.url })
            yield* this.#append(transferId, offset, response.body)
          })
        ).pipe(
          Effect.map(() => true),
          // Whatever this address did, another may serve the pull: it can
          // reach something other than the source, such as another Relay
          // or a router's page. Once every address had its turn, the pull
          // is tried again if any of them may answer later.
          Effect.catchIf(
            (error): error is PeerFetchError => error instanceof PeerFetchError,
            (error) =>
              Effect.sync(() => {
                if (!lastError?.retryable || error.retryable) lastError = error
                return false
              })
          )
        )
        if (fetched) return
      }
      return yield* (
        lastError ??
          new PeerFetchError({
            reason: "No endpoint of the source Relay answered",
            retryable: true,
          })
      )
    })
  }

  // Streams a response onto the end of the part file, noting progress.
  #append(transferId: string, offset: number, body: Readable) {
    return Effect.gen({ self: this }, function* () {
      let received = offset
      const update = (bytes: number) => this.#progress(transferId, bytes)
      yield* Effect.tryPromise({
        try: (signal) =>
          pipeline(
            body,
            async function* (chunks: AsyncIterable<Buffer>) {
              for await (const chunk of chunks) {
                received += chunk.byteLength
                update(received)
                yield chunk
              }
            },
            createWriteStream(this.#partPath(transferId), {
              flags: "a",
              mode: 0o600,
            }),
            { signal }
          ),
        catch: (cause) =>
          new PeerFetchError({
            reason: `The transfer stopped after ${received} bytes`,
            retryable: true,
            cause,
          }),
      })
      yield* this.#update(transferId, { receivedBytes: received })
    })
  }

  // Keeps progress current in memory, and on disk now and then.
  #progress(transferId: string, receivedBytes: number) {
    const record = this.#records.get(transferId)
    if (!record) return
    const now = Date.now()
    this.#records.set(transferId, {
      ...record,
      pull: { ...record.pull, receivedBytes, updatedAt: now },
    })
    if (now - (this.#savedAt.get(transferId) ?? 0) < PROGRESS_INTERVAL_MS)
      return
    this.#savedAt.set(transferId, now)
    Effect.runFork(
      this.#save(this.#records.get(transferId) ?? record).pipe(Effect.ignore)
    )
  }

  #update(
    transferId: string,
    change: Partial<
      Pick<RelayTransferPull, "endpoint" | "error" | "receivedBytes" | "state">
    >
  ) {
    return Effect.gen({ self: this }, function* () {
      const record = this.#records.get(transferId)
      if (!record) return yield* Effect.fail(new Error("Transfer not found"))
      const next: PullRecord = {
        ...record,
        pull: {
          ...record.pull,
          ...change,
          updatedAt: yield* Clock.currentTimeMillis,
        },
      }
      yield* this.#save(next)
      return next.pull
    })
  }

  #save(record: PullRecord) {
    const { transferId } = record.pull
    this.#records.set(transferId, record)
    let saving = this.#saving.get(transferId)
    if (!saving) {
      saving = Semaphore.makeUnsafe(1)
      this.#saving.set(transferId, saving)
    }
    // Whichever write runs last writes the latest record.
    return saving.withPermits(1)(
      Effect.suspend(() =>
        writeTransferRecord(
          this.#options.directory,
          transferId,
          PullRecordSchema,
          this.#records.get(transferId) ?? record
        )
      )
    )
  }

  #partSize(transferId: string) {
    return Effect.tryPromise(() => stat(this.#partPath(transferId))).pipe(
      Effect.map((metadata) => metadata.size),
      Effect.orElseSucceed(() => 0)
    )
  }

  #removePart(transferId: string) {
    return Effect.tryPromise(() =>
      rm(this.#partPath(transferId), { force: true })
    ).pipe(Effect.ignore)
  }

  #partPath(transferId: string) {
    return join(this.#options.directory, `${transferId}.part`)
  }
}

// The endpoint that last answered first, then the rest in Hearth's order.
function orderedEndpoints(
  record: PullRecord
): ReadonlyArray<RelayPeerEndpoint> {
  const last = record.pull.endpoint
  return last
    ? [
        ...record.endpoints.filter((endpoint) => endpoint.url === last),
        ...record.endpoints.filter((endpoint) => endpoint.url !== last),
      ]
    : record.endpoints
}

function decodeGrant(token: string) {
  return Effect.try({
    try: () => {
      const encoded = token.split(".", 1)[0] ?? ""
      return Schema.decodeUnknownSync(
        Schema.fromJsonString(RelayPeerTransferGrantSchema)
      )(Buffer.from(encoded, "base64url").toString("utf8"))
    },
    catch: (cause) => new Error("The transfer grant is invalid", { cause }),
  })
}

const hashFile = Effect.fn("RelayTransfer.verify")(function* (path: string) {
  return yield* Effect.tryPromise(async () => {
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer)
    }
    return hash.digest("hex")
  })
})

function finished(state: RelayTransferPull["state"]) {
  return state === "completed" || state === "failed" || state === "cancelled"
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.slice(0, 500)
}
