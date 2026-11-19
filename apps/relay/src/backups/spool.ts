import { link, mkdir, readdir, rm, stat } from "node:fs/promises"
import { resolve } from "node:path"

import { Clock, Effect, Queue, Result } from "effect"

import type { RelayConfig } from "../config.js"
import { RelayBackupError } from "../effect/errors.js"
import { promiseEffect } from "../effect/promise.js"
import {
  RelayStateStore,
  type SpooledBackupCopy,
} from "../effect/state.js"
import {
  LaneRejectedError,
  laneKeys,
  type OperationLanes,
} from "../operation-lanes.js"
import { operation, runOperation } from "../operations/operation.js"
import { backupArchivePath } from "./destinations/local/index.js"
import { uploadSignedArchive } from "./destinations/s3/index.js"
import { backupFailureCode } from "./failure.js"
import {
  isAccessDeferred,
  isHearthUnreachable,
  type BackupCopySettled,
  type HearthStorageAccess,
} from "./storage-access.js"

// How long a copy waits before its Hearth is asked again.
const HEARTH_RETRY_MS = 60_000
// A bucket that fails an upload is tried again this many times, a minute
// apart and then twice as long each time, before the copy is given up.
const UPLOAD_ATTEMPTS = 5

/**
 * The spool: copies of backups waiting on the Relay to be sent to a bucket
 * that only Hearth can open.
 *
 * A backup's task ends once its archive is taken. Each copy of it for such
 * a bucket is added here, and one worker sends them in turn: it asks the
 * copy's Hearth for one signed request, sends the archive with it, and
 * tells Hearth how that ended. With Hearth away a copy only waits, so a
 * backup is taken on time whether or not Hearth can be reached, and every
 * upload takes this one path.
 *
 * A copy owns a hard link to its archive, so nothing else that removes the
 * archive, as deleting the Relay's own copy does, takes away what is still
 * to be sent. What it keeps is in SQLite (`relay_backup_spool`), so a
 * restart sends what was waiting.
 */
export class BackupSpool {
  readonly #config: RelayConfig
  readonly #lanes: OperationLanes
  readonly #settled: BackupCopySettled
  readonly #state: RelayStateStore["Service"]
  readonly #storage: HearthStorageAccess
  readonly #wake: Queue.Queue<void>
  /** The uploads under way, so a withdrawn copy's can be stopped. */
  readonly #sending = new Map<string, AbortController>()

  private constructor(options: {
    config: RelayConfig
    lanes: OperationLanes
    settled: BackupCopySettled
    state: RelayStateStore["Service"]
    storage: HearthStorageAccess
    wake: Queue.Queue<void>
  }) {
    this.#config = options.config
    this.#lanes = options.lanes
    this.#settled = options.settled
    this.#state = options.state
    this.#storage = options.storage
    this.#wake = options.wake
  }

  static make(options: {
    config: RelayConfig
    lanes: OperationLanes
    /** Tells a copy's Hearth how sending it ended. */
    settled: BackupCopySettled
    /** Asks a copy's Hearth for the request that sends it. */
    storage: HearthStorageAccess
  }) {
    return Effect.gen(function* () {
      const state = yield* RelayStateStore
      return new BackupSpool({
        ...options,
        state,
        wake: yield* Queue.unbounded<void>(),
      })
    })
  }

  /**
   * Adds a copy of a backup whose archive is taken, to be sent. Answers
   * `full` when its Hearth's copies already take all the room the spool
   * gives one Hearth, and the copy isn't kept.
   */
  add(copy: {
    archiveId: string
    backupId: string
    bytes: number
    copyId: string
    hearth: string | null
  }) {
    return Effect.gen({ self: this }, function* () {
      const held = this.#path(copy.copyId)
      yield* promiseEffect(async () => {
        await mkdir(this.#directory(), { mode: 0o700, recursive: true })
        await rm(held, { force: true })
        await link(backupArchivePath(this.#config, copy.archiveId), held)
      })
      const added = yield* this.#state.spoolBackupCopy(
        copy,
        yield* Clock.currentTimeMillis,
        this.#config.backupOutboxBytes
      )
      if (!added) {
        yield* promiseEffect(() => rm(held, { force: true }))
        return "full" as const
      }
      // It waits for its backup's create to end well (`taken`): a create
      // that fails or is cancelled after this takes its copies with it.
      return "spooled" as const
    })
  }

  /**
   * A backup's create has ended well: its copies are the backup's now, and
   * are sent. Until then none is, so nothing reaches a bucket for a backup
   * that then fails.
   */
  taken() {
    return Queue.offer(this.#wake, undefined).pipe(Effect.asVoid)
  }

  /**
   * Keeps a backup's copies from being sent while the backup is deleted:
   * stops one being sent, and leaves them a while. A delete that ends well
   * withdraws them; after one that doesn't they are sent again, so no copy
   * is left waiting with nothing to send it.
   */
  hold(backupId: string) {
    return Effect.gen({ self: this }, function* () {
      const held = yield* this.#state.postponeSpooledBackupCopiesOf(
        backupId,
        (yield* Clock.currentTimeMillis) + HEARTH_RETRY_MS
      )
      for (const copy of yield* this.#state.spooledBackupCopies()) {
        if (copy.backupId === backupId) this.#sending.get(copy.copyId)?.abort()
      }
      return held
    })
  }

  /**
   * Takes a backup's copies out of the spool, once the backup is deleted
   * or its create has failed: stops one being sent, and removes what the
   * spool kept of them.
   */
  withdraw(backupId: string, except: ReadonlySet<string> = new Set()) {
    return Effect.gen({ self: this }, function* () {
      const copies = yield* this.#state.withdrawSpooledBackupCopies(backupId, [
        ...except,
      ])
      for (const copy of copies) {
        this.#sending.get(copy.copyId)?.abort()
        yield* promiseEffect(() => rm(this.#path(copy.copyId), { force: true }))
      }
      return copies
    })
  }

  /** Brings a Hearth's copies forward, as it connects. */
  hearthReachable(hearth: string) {
    return Effect.gen({ self: this }, function* () {
      const hastened = yield* this.#state.hastenSpooledBackupCopies(
        hearth,
        yield* Clock.currentTimeMillis
      )
      if (hastened > 0) yield* Queue.offer(this.#wake, undefined)
    })
  }

  /** The worker: sends what is due, then waits for more or for a turn. */
  run() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        yield* this.runPending()
        const next = yield* this.#state.nextSpooledBackupCopyAt()
        const now = yield* Clock.currentTimeMillis
        const woken = Queue.take(this.#wake)
        yield* next === null
          ? woken
          : Effect.raceFirst(
              woken,
              Effect.sleep(Math.max(1_000, next - now))
            )
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The backup spool stopped", cause)
      )
    )
  }

  /** Sends and reports every copy whose turn has come, once each. */
  runPending() {
    return Effect.gen({ self: this }, function* () {
      const due = yield* this.#state.dueSpooledBackupCopies(
        yield* Clock.currentTimeMillis
      )
      for (const copy of due) {
        const sent = yield* Effect.result(
          runOperation(this.#lanes, this.#ship, copy, { kind: "worker" })
        )
        if (Result.isSuccess(sent)) continue
        // Turned away by a pause, or failed in a way that says nothing of
        // the copy: it keeps its place for another turn.
        yield* this.#later(copy)
        if (!(sent.failure instanceof LaneRejectedError)) {
          yield* Effect.logWarning("A spooled backup copy was not handled", {
            cause: sent.failure,
            copyId: copy.copyId,
          })
        }
      }
    })
  }

  readonly #ship = operation<SpooledBackupCopy>()({
    name: "relay.backups.ship",
    // The archive it sends, which deleting the backup takes alone.
    locks: ({ input }) => [
      { key: laneKeys.backupArchive(input.archiveId), mode: "exclusive" },
    ],
    run: ({ input }) => this.#handle(input),
  })

  // One copy's turn: send it if it still waits, then tell Hearth.
  #handle(due: SpooledBackupCopy) {
    return Effect.gen({ self: this }, function* () {
      // Withdrawn since it was read, as its backup was deleted.
      const copy = (yield* this.#state.spooledBackupCopies()).find(
        ({ copyId }) => copyId === due.copyId
      )
      if (!copy) return
      const settled =
        copy.state === "waiting" ? yield* this.#send(copy) : copy
      if (settled === null || settled.state === "waiting") return
      const heard = yield* Effect.result(
        this.#settled(
          {
            artifactId: copy.copyId,
            error: settled.error,
            errorCode: settled.errorCode,
            status: settled.state === "stored" ? "available" : "failed",
          },
          copy.hearth
        )
      )
      if (Result.isFailure(heard)) return yield* this.#later(copy)
      yield* this.#state.removeSpooledBackupCopy(copy.copyId)
      yield* promiseEffect(() => rm(this.#path(copy.copyId), { force: true }))
    })
  }

  // Sends a waiting copy. Answers with how it ended, or null when it only
  // waits for another turn.
  #send(copy: SpooledBackupCopy) {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      const path = this.#path(copy.copyId)
      const size = yield* promiseEffect(() => stat(path)).pipe(
        Effect.map((found) => found.size),
        Effect.orElseSucceed(() => null)
      )
      if (size !== copy.bytes) {
        return yield* this.#settle(copy, now, {
          error: "The archive waiting to be sent is no longer on the Relay",
          errorCode: "spooled_archive_missing",
        })
      }
      const controller = new AbortController()
      this.#sending.set(copy.copyId, controller)
      const sent = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          // Asked for only now: what Hearth signs is good for minutes.
          const grant = yield* this.#storage(
            { action: "upload", artifactId: copy.copyId },
            copy.hearth
          )
          yield* uploadSignedArchive({
            allowPrivateNetwork: grant.allowPrivateNetwork,
            bytes: copy.bytes,
            headers: grant.headers,
            path,
            signal: controller.signal,
            url: grant.url,
          })
        })
      ).pipe(
        Effect.ensuring(Effect.sync(() => this.#sending.delete(copy.copyId)))
      )
      if (Result.isSuccess(sent)) return yield* this.#settle(copy, now, null)
      // Withdrawn while it was being sent: there is nothing left to record.
      if (controller.signal.aborted) return null
      const failure = sent.failure
      // Hearth being away says nothing of the copy, however long. Nor
      // does its saying not yet, as while the copy's backup is being
      // deleted: the archive is kept until how that ended is known.
      if (isHearthUnreachable(failure) || isAccessDeferred(failure)) {
        yield* this.#later(copy)
        return null
      }
      const refused =
        failure instanceof RelayBackupError &&
        failure.code === "storage_access_refused"
      if (refused || copy.attempts + 1 >= UPLOAD_ATTEMPTS) {
        return yield* this.#settle(copy, now, {
          error:
            failure instanceof Error
              ? failure.message
              : "The backup's copy could not be sent",
          errorCode: backupFailureCode(failure),
        })
      }
      yield* this.#state.deferSpooledBackupCopy(
        copy.copyId,
        now + HEARTH_RETRY_MS * 2 ** copy.attempts,
        now
      )
      return null
    })
  }

  #settle(
    copy: SpooledBackupCopy,
    now: number,
    failure: { error: string; errorCode: string | null } | null
  ) {
    return this.#state
      .settleSpooledBackupCopy(
        copy.copyId,
        failure ? { ...failure, state: "failed" } : { state: "stored" },
        now
      )
      .pipe(
        // Sent, or never to be: the archive it held has no more use here,
        // and only its outcome waits for Hearth to hear of it. Kept, it
        // would take room the spool's limit doesn't count.
        Effect.andThen(
          promiseEffect(() => rm(this.#path(copy.copyId), { force: true }))
        ),
        Effect.as({
          error: failure?.error ?? null,
          errorCode: failure?.errorCode ?? null,
          state: failure ? ("failed" as const) : ("stored" as const),
        })
      )
  }

  // Keeps a copy for a later turn without counting against it.
  #later(copy: SpooledBackupCopy) {
    return Effect.gen({ self: this }, function* () {
      yield* this.#state.postponeSpooledBackupCopy(
        copy.copyId,
        (yield* Clock.currentTimeMillis) + HEARTH_RETRY_MS
      )
    })
  }

  /**
   * As the Relay starts, once the tasks a stop cut off are back in line. A
   * copy whose backup is one of those leaves the spool: the task takes the
   * archive again, and adds it again. A file no copy owns is left over
   * from one that was removed.
   */
  recover() {
    return Effect.gen({ self: this }, function* () {
      yield* this.#state.withdrawSpooledCopiesOfUnfinishedBackups()
      const copies = yield* this.#state.spooledBackupCopies()
      // Only a copy still to be sent keeps its archive. One a stop caught
      // between being settled and giving its link up has no use for it,
      // and would hold room the spool's limit doesn't count.
      const known = new Set(
        copies.flatMap(({ copyId, state }) =>
          state === "waiting" ? [`${copyId}.zip`] : []
        )
      )
      const files = yield* promiseEffect(() => readdir(this.#directory())).pipe(
        Effect.orElseSucceed((): Array<string> => [])
      )
      for (const file of files) {
        if (known.has(file)) continue
        yield* promiseEffect(() =>
          rm(resolve(this.#directory(), file), { force: true })
        )
      }
    })
  }

  #directory() {
    // Beside the backups, on the same filesystem: a copy is a hard link.
    return resolve(this.#config.dataDirectory, "backup-spool")
  }

  #path(copyId: string) {
    return resolve(this.#directory(), `${copyId}.zip`)
  }
}
