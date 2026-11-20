/**
 * The artifacts this Relay serves to other Relays. Hearth asks for one with
 * `transfer.source.prepare`; it's packed in the background, served to the
 * Relay its grant names, and deleted when Hearth discards it or it expires.
 */
import { join } from "node:path"
import { Clock, Deferred, Effect, Exit, Fiber } from "effect"

import {
  RelayTransferSourceSchema,
  type RelayTransferReference,
  type RelayTransferSource,
  type RelayTransferSourcePrepare,
} from "@workspace/contracts"

import type { OperationLanes } from "../../operation-lanes.js"
import {
  ensureTransferDirectory,
  readTransferRecords,
  removeTransferFiles,
  writeTransferRecord,
} from "./manifests.js"
import type { TransferRootResolver } from "./roots.js"

// How long an artifact nobody discarded is kept.
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000

export interface TransferSourcesOptions {
  /** Where artifacts and their records are kept. */
  readonly directory: string
  readonly lanes: OperationLanes
  readonly resolveRoot: TransferRootResolver
  readonly retentionMs?: number
}

export interface TransferArtifact {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

// An artifact being packed. Once its turn comes its pack runs whether or
// not anyone waits for it, as all work in the lanes does, so stopping one
// takes asking it to and waiting until it has.
interface Packing {
  /** What waits for the pack's turn and then for the pack, once forked. */
  fiber: Fiber.Fiber<void> | null
  /** Done to stop the pack where it is. */
  readonly stop: Deferred.Deferred<void>
  /** Done once a pack that started has ended and cleaned up after itself. */
  readonly ended: Deferred.Deferred<void>
  /** Whether its turn came. */
  started: boolean
}

export class TransferSources {
  readonly #options: TransferSourcesOptions
  readonly #records = new Map<string, RelayTransferSource>()
  readonly #packing = new Map<string, Packing>()

  constructor(options: TransferSourcesOptions) {
    this.#options = options
  }

  /**
   * Loads the records of a previous run. An artifact still packing when the
   * Relay stopped is incomplete, so it fails; expired ones are removed.
   */
  load() {
    return Effect.gen({ self: this }, function* () {
      const records = yield* readTransferRecords(
        this.#options.directory,
        RelayTransferSourceSchema
      )
      for (const record of records) {
        if (record.state === "packing") {
          yield* this.#save({
            ...record,
            error: "The Relay restarted while packing this transfer",
            state: "failed",
          })
        } else {
          this.#records.set(record.transferId, record)
        }
      }
      yield* this.sweep()
    }).pipe(Effect.withSpan("RelayTransfer.loadSources"))
  }

  /**
   * Starts packing an artifact, or returns the one already prepared under
   * this transfer ID for the same root.
   */
  prepare(input: RelayTransferSourcePrepare) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.annotateCurrentSpan({
        "kiln.transfer.id": input.transferId,
        "kiln.file_root.id": input.rootId,
      })
      const existing = this.#records.get(input.transferId)
      if (existing) {
        if (existing.rootId !== input.rootId) {
          return yield* Effect.fail(
            new Error("This transfer ID is already used for another root")
          )
        }
        return existing
      }
      const now = yield* Clock.currentTimeMillis
      const record: RelayTransferSource = {
        createdAt: now,
        entries: null,
        error: null,
        expiresAt: now + (this.#options.retentionMs ?? DEFAULT_RETENTION_MS),
        rootId: input.rootId,
        sha256: null,
        size: null,
        state: "packing",
        transferId: input.transferId,
      }
      yield* ensureTransferDirectory(this.#options.directory)
      yield* this.#save(record)
      const packing: Packing = {
        ended: yield* Deferred.make<void>(),
        fiber: null,
        started: false,
        stop: yield* Deferred.make<void>(),
      }
      packing.fiber = yield* this.#pack(record, input.paths, packing).pipe(
        Effect.ensuring(
          Effect.sync(() => this.#packing.delete(record.transferId))
        ),
        Effect.forkDetach
      )
      this.#packing.set(record.transferId, packing)
      return record
    }).pipe(Effect.withSpan("RelayTransfer.prepareSource"))
  }

  get(reference: RelayTransferReference): RelayTransferSource | null {
    const record = this.#records.get(reference.transferId)
    return record && record.rootId === reference.rootId ? record : null
  }

  /** A transfer's record, whatever its state. */
  artifactRecord(transferId: string): RelayTransferSource | null {
    return this.#records.get(transferId) ?? null
  }

  /** The artifact a peer may fetch, once it's ready and until it expires. */
  artifact(transferId: string, now: number): TransferArtifact | null {
    const record = this.#records.get(transferId)
    if (
      !record ||
      record.state !== "ready" ||
      record.expiresAt <= now ||
      record.size === null ||
      record.sha256 === null
    ) {
      return null
    }
    return {
      path: this.#artifactPath(transferId),
      sha256: record.sha256,
      size: record.size,
    }
  }

  /** Stops packing an artifact if it still is, and deletes it. */
  discard(reference: RelayTransferReference) {
    return Effect.gen({ self: this }, function* () {
      const record = this.get(reference)
      if (!record) return false
      yield* this.#remove(record.transferId)
      return true
    }).pipe(Effect.withSpan("RelayTransfer.discardSource"))
  }

  /** Deletes artifacts past their expiry. */
  sweep() {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      for (const record of this.#records.values()) {
        if (record.expiresAt <= now) yield* this.#remove(record.transferId)
      }
    })
  }

  #pack(
    record: RelayTransferSource,
    paths: ReadonlyArray<string>,
    packing: Packing
  ) {
    const options = this.#options
    return Effect.gen({ self: this }, function* () {
      const target = yield* Effect.tryPromise(() =>
        options.resolveRoot(record.rootId)
      )
      const artifact = this.#artifactPath(record.transferId)
      const packed = yield* options.lanes.run(
        { label: "transfer.source.pack", locks: target.packLocks },
        Effect.gen(function* () {
          packing.started = true
          // Stopped from inside its turn: the pack is interrupted, and has
          // removed what it wrote, before its lanes are let go.
          const pack = yield* Effect.forkChild(target.pack(paths, artifact))
          yield* Effect.forkChild(
            Deferred.await(packing.stop).pipe(
              Effect.andThen(Fiber.interrupt(pack))
            )
          )
          const exit = yield* Fiber.await(pack)
          if (Exit.isSuccess(exit)) return exit.value
          return yield* Exit.hasInterrupts(exit)
            ? Effect.fail(new Error("This transfer was discarded"))
            : Effect.failCause(exit.cause)
        }).pipe(Effect.ensuring(Deferred.succeed(packing.ended, undefined)))
      )
      yield* Effect.annotateCurrentSpan({
        "kiln.transfer.bytes": packed.size,
        "kiln.transfer.entries": packed.entries,
      })
      yield* this.#save({
        ...record,
        entries: packed.entries,
        sha256: packed.sha256,
        size: packed.size,
        state: "ready",
      })
    }).pipe(
      Effect.catch((cause) =>
        this.#save({
          ...record,
          error: errorMessage(cause),
          state: "failed",
        })
      ),
      Effect.catchCause(() => Effect.void),
      Effect.withSpan("RelayTransfer.pack", {
        attributes: {
          "kiln.transfer.id": record.transferId,
          "kiln.file_root.id": record.rootId,
        },
      })
    )
  }

  #save(record: RelayTransferSource) {
    return writeTransferRecord(
      this.#options.directory,
      record.transferId,
      RelayTransferSourceSchema,
      record
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => this.#records.set(record.transferId, record))
      )
    )
  }

  // Its record goes last, so its ID isn't taken again while a pack under it
  // is still stopping.
  #remove(transferId: string) {
    return Effect.gen({ self: this }, function* () {
      const packing = this.#packing.get(transferId)
      if (packing) {
        yield* Deferred.succeed(packing.stop, undefined)
        // Withdraws one still waiting its turn, which then never starts.
        if (packing.fiber) yield* Fiber.interrupt(packing.fiber)
        if (packing.started) yield* Deferred.await(packing.ended)
      }
      this.#records.delete(transferId)
      yield* removeTransferFiles(this.#options.directory, transferId)
    })
  }

  #artifactPath(transferId: string) {
    return join(this.#options.directory, `${transferId}.tar.gz`)
  }
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.slice(0, 500)
}
