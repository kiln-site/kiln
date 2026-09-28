import { type ChildProcess, fork } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, lstat, open, stat } from "node:fs/promises"
import type { Duplex } from "node:stream"
import { fileURLToPath } from "node:url"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
  RelayFileDatabaseReadInput,
  RelayFileDatabaseWriteInput,
} from "@workspace/contracts"
import { Deferred, Effect, Pool, Scope } from "effect"

import type { RelayInstanceConfig } from "./config.js"
import {
  COMMIT_CHANNEL_FD,
  COMMIT_GRANTED,
  COMMIT_REQUEST,
} from "./database-browser-protocol.js"
import type {
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
} from "./database-browser-worker.js"
import { RelayDatabaseBrowserError } from "./effect/errors.js"
import { promiseEffect } from "./effect/promise.js"
import type { FilesystemDriver } from "./files.js"

const WORKER_TIMEOUT = "20 seconds"
const WORKER_IDLE = "30 seconds"
const MAX_ACTIVE_WORKERS = 4
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1")
const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"] as const

export class DatabaseBrowser {
  readonly #filesystem: FilesystemDriver
  readonly #workers = new DatabaseWorkerPool()

  constructor(filesystem: FilesystemDriver) {
    this.#filesystem = filesystem
  }

  read(instance: RelayInstanceConfig, input: RelayFileDatabaseReadInput) {
    return this.#run(instance, input.path, input.request, true)
  }

  write(instance: RelayInstanceConfig, input: RelayFileDatabaseWriteInput) {
    return this.#run(instance, input.path, input.request, false)
  }

  #run(
    instance: RelayInstanceConfig,
    requestedPath: string,
    request: DatabaseReadRequest | DatabaseWriteRequest,
    readOnly: boolean
  ) {
    return Effect.gen({ self: this }, function* () {
      const path = yield* this.#filesystem.resolveFile(instance, requestedPath)
      yield* assertSqliteFile(path)
      const writable = yield* promiseEffect(() =>
        access(path, fsConstants.W_OK)
      ).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (!readOnly && !writable) {
        return yield* Effect.fail(
          RelayDatabaseBrowserError.make({
            code: "read_only_file",
            reason: "The database file is read-only on disk",
          })
        )
      }
      const result = yield* this.#workers.run({ path, readOnly, request })
      if (request.action !== "overview") return result
      const metadata = yield* databaseOperation("stat", () => stat(path))
      return {
        ...(result as object),
        modifiedAt: metadata.mtime.toISOString(),
        readOnly: !writable,
        sizeBytes: metadata.size,
      }
    }).pipe(Effect.withSpan(`relay.files.database.${request.action}`))
  }
}

function assertSqliteFile(path: string) {
  return Effect.gen(function* () {
    const header = yield* Effect.acquireUseRelease(
      databaseOperation("inspect.open", () => open(path, "r")),
      (handle) =>
        databaseOperation("inspect.read", async () => {
          const buffer = Buffer.alloc(SQLITE_HEADER.byteLength)
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.byteLength,
            0
          )
          return buffer.subarray(0, bytesRead)
        }),
      (handle) =>
        promiseEffect(() => handle.close()).pipe(
          Effect.catch(() => Effect.void)
        )
    )
    // An empty file is a valid, empty SQLite database.
    if (header.byteLength > 0) {
      if (header.subarray(0, 4).toString("latin1") === "H:2,") {
        return yield* Effect.fail(
          databaseError(
            "unsupported_engine",
            "H2 databases can't be browsed yet. Download the file to inspect it locally."
          )
        )
      }
      if (!header.equals(SQLITE_HEADER)) {
        return yield* Effect.fail(
          databaseError("not_a_database", "This file is not a SQLite database")
        )
      }
    }
    // SQLite opens journals by name next to the database. A symlinked journal
    // would let a query write through to a file outside the instance.
    for (const suffix of SQLITE_SIDECARS) {
      const metadata = yield* promiseEffect(() =>
        lstat(`${path}${suffix}`)
      ).pipe(Effect.catch(() => Effect.succeed(null)))
      if (metadata && !metadata.isFile()) {
        return yield* Effect.fail(
          databaseError(
            "unsafe_journal",
            `Refusing to open the database because ${suffix.slice(1)} is not a regular file`
          )
        )
      }
    }
  })
}

function databaseOperation<TResult>(
  operation: string,
  run: () => Promise<TResult>
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RelayDatabaseBrowserError
        ? cause
        : RelayDatabaseBrowserError.make({
            code: `${operation}_failed`,
            reason:
              cause instanceof Error
                ? cause.message
                : "The database operation failed",
            cause,
          }),
  })
}

function databaseError(code: string, reason: string) {
  return RelayDatabaseBrowserError.make({ code, reason })
}

// Workers come from an Effect Pool: at most MAX_ACTIVE_WORKERS run at once,
// further requests wait for one, and idle workers are kept briefly for reuse.
class DatabaseWorkerPool {
  // The pool lives as long as the Relay, so its scope is never closed.
  readonly #pool = Effect.runSync(
    Effect.cached(
      Pool.makeWithTTL({
        acquire: Effect.acquireRelease(Effect.sync(spawnWorker), stopWorker),
        min: 0,
        max: MAX_ACTIVE_WORKERS,
        timeToLive: WORKER_IDLE,
        timeToLiveStrategy: "usage",
      }).pipe(Scope.provide(Scope.makeUnsafe()))
    )
  )

  run(request: DatabaseWorkerRequest) {
    const pool = this.#pool
    return Effect.gen(function* () {
      const job: DatabaseJobState = { stage: "queued", worker: null }
      const reply = yield* Deferred.make<unknown, RelayDatabaseBrowserError>()
      // The job holds its worker until the worker answers or dies, so the
      // pool never counts a busy worker as free.
      yield* Effect.gen(function* () {
        const workers = yield* pool
        const worker = yield* Pool.get(workers)
        if (job.stage === "cancelled") return undefined
        job.stage = "running"
        job.worker = worker
        const response = yield* exchange(worker, request, job).pipe(
          Effect.tapError(() => Pool.invalidate(workers, worker))
        )
        if (!response.ok) {
          return yield* Effect.fail(
            databaseError(response.code, response.message)
          )
        }
        return response.result
      }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(reply, exit)),
        Effect.forkDetach
      )
      return yield* Deferred.await(reply).pipe(
        Effect.timeoutOrElse({
          duration: WORKER_TIMEOUT,
          orElse: () =>
            cancelJob(job)
              ? Effect.fail(
                  databaseError(
                    "timeout",
                    `The database operation took longer than ${WORKER_TIMEOUT} and was stopped. Nothing was saved.`
                  )
                )
              : Deferred.await(reply),
        }),
        Effect.onInterrupt(() => Effect.sync(() => cancelJob(job)))
      )
    })
  }
}

interface DatabaseJobState {
  stage: "queued" | "running" | "committing" | "cancelled"
  worker: ChildProcess | null
}

// Stops a job by killing its worker, which ends even a SQLite step that
// never returns and rolls back its transaction. A job whose commit was
// already granted is left to finish instead; returns false in that case.
function cancelJob(job: DatabaseJobState) {
  if (job.stage === "committing") return false
  job.stage = "cancelled"
  job.worker?.kill("SIGKILL")
  return true
}

function exchange(
  worker: ChildProcess,
  message: DatabaseWorkerRequest,
  job: DatabaseJobState
) {
  return Effect.callback<DatabaseWorkerResponse, RelayDatabaseBrowserError>(
    (resume) => {
      const commitChannel = worker.stdio[COMMIT_CHANNEL_FD] as Duplex
      const settle = (
        effect: Effect.Effect<DatabaseWorkerResponse, RelayDatabaseBrowserError>
      ) => {
        detach()
        resume(effect)
      }
      // Granting is decided here on the Relay's single thread, so it can
      // never interleave with cancelJob.
      const onCommitRequest = (data: Buffer) => {
        if (job.stage !== "running" || !data.includes(COMMIT_REQUEST)) return
        job.stage = "committing"
        commitChannel.write(COMMIT_GRANTED)
      }
      const onMessage = (response: DatabaseWorkerResponse) =>
        settle(Effect.succeed(response))
      const onError = (error: Error) =>
        settle(Effect.fail(databaseError("worker_failed", error.message)))
      const onExit = () =>
        settle(
          Effect.fail(
            databaseError("worker_exit", "The database worker stopped")
          )
        )
      const detach = () => {
        commitChannel.off("data", onCommitRequest)
        worker.off("message", onMessage)
        worker.off("error", onError)
        worker.off("exit", onExit)
      }
      commitChannel.on("data", onCommitRequest)
      worker.on("message", onMessage)
      worker.on("error", onError)
      worker.on("exit", onExit)
      worker.send(message)
      return Effect.sync(detach)
    }
  )
}

function spawnWorker() {
  const development = import.meta.url.endsWith(".ts")
  const entry = new URL(
    development
      ? "./database-browser-worker.ts"
      : "./database-browser-worker.mjs",
    import.meta.url
  )
  return fork(fileURLToPath(entry), [], {
    // Production workers skip the Relay's own preloads (Sentry); development
    // keeps tsx's loader so the TypeScript entry can run.
    execArgv: [
      ...(development
        ? process.execArgv.filter((flag) => !flag.startsWith("--inspect"))
        : []),
      "--disable-warning=ExperimentalWarning",
    ],
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "pipe", "ipc"],
  })
}

function stopWorker(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return Effect.void
  }
  return Effect.callback<void>((resume) => {
    worker.once("exit", () => resume(Effect.void))
    worker.kill()
  })
}
