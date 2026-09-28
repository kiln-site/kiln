import { constants as fsConstants } from "node:fs"
import { access, lstat, open, stat } from "node:fs/promises"
import { Worker } from "node:worker_threads"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
  RelayFileDatabaseReadInput,
  RelayFileDatabaseWriteInput,
} from "@workspace/contracts"
import { Deferred, Effect, Pool, Scope } from "effect"

import type { RelayInstanceConfig } from "./config.js"
import {
  cancelJob,
  createJobControl,
  isJobCancelled,
} from "./database-browser-control.js"
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

type PoolRequest = Omit<DatabaseWorkerRequest, "control">

// Workers come from an Effect Pool: at most MAX_ACTIVE_WORKERS run at once,
// further requests wait for one, and idle workers are kept briefly for reuse.
class DatabaseWorkerPool {
  // The pool lives as long as the Relay, so its scope is never closed.
  readonly #pool = Effect.runSync(
    Effect.cached(
      Pool.makeWithTTL({
        acquire: Effect.acquireRelease(
          Effect.sync(() => {
            const worker = spawnWorker()
            // A parked worker must not keep the process alive on its own.
            worker.unref()
            return worker
          }),
          (worker) =>
            promiseEffect(() => worker.terminate()).pipe(Effect.ignore)
        ),
        min: 0,
        max: MAX_ACTIVE_WORKERS,
        timeToLive: WORKER_IDLE,
        timeToLiveStrategy: "usage",
      }).pipe(Scope.provide(Scope.makeUnsafe()))
    )
  )

  run(request: PoolRequest) {
    const pool = this.#pool
    return Effect.gen(function* () {
      const control = createJobControl()
      const reply = yield* Deferred.make<unknown, RelayDatabaseBrowserError>()
      // The job keeps its worker until the worker answers, even after the
      // caller stops waiting, so a busy worker is never counted as free.
      yield* Effect.gen(function* () {
        const workers = yield* pool
        const worker = yield* Pool.get(workers)
        if (isJobCancelled(control)) return undefined
        const response = yield* exchange(worker, { ...request, control }).pipe(
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
          // A job that already started committing is left to finish, so the
          // caller learns whether the write landed.
          orElse: () =>
            cancelJob(control)
              ? Effect.fail(
                  databaseError(
                    "timeout",
                    `The database operation took longer than ${WORKER_TIMEOUT} and was cancelled. Nothing was saved.`
                  )
                )
              : Deferred.await(reply),
        }),
        Effect.onInterrupt(() => Effect.sync(() => cancelJob(control)))
      )
    })
  }
}

function exchange(worker: Worker, message: DatabaseWorkerRequest) {
  return Effect.callback<DatabaseWorkerResponse, RelayDatabaseBrowserError>(
    (resume) => {
      const settle = (
        effect: Effect.Effect<DatabaseWorkerResponse, RelayDatabaseBrowserError>
      ) => {
        detach()
        resume(effect)
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
        worker.off("message", onMessage)
        worker.off("error", onError)
        worker.off("exit", onExit)
      }
      worker.on("message", onMessage)
      worker.on("error", onError)
      worker.on("exit", onExit)
      worker.postMessage(message)
      return Effect.sync(detach)
    }
  )
}

function spawnWorker() {
  if (!import.meta.url.endsWith(".ts")) {
    return new Worker(new URL("./database-browser-worker.mjs", import.meta.url))
  }
  // tsx does not install its resolver inside worker threads, so development
  // registers it before importing the TypeScript entry.
  const entry = new URL("./database-browser-worker.ts", import.meta.url)
  const tsx = import.meta.resolve("tsx/esm/api")
  return new Worker(
    `import(${JSON.stringify(tsx)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.href)}) })`,
    { eval: true }
  )
}
