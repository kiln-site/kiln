import { constants as fsConstants } from "node:fs"
import { access, lstat, open, stat } from "node:fs/promises"
import { Worker } from "node:worker_threads"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
  RelayFileDatabaseReadInput,
  RelayFileDatabaseWriteInput,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayInstanceConfig } from "./config.js"
import type {
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
} from "./database-browser-worker.js"
import { RelayDatabaseBrowserError } from "./effect/errors.js"
import type { FilesystemDriver } from "./files.js"

const WORKER_TIMEOUT_MS = 20_000
const WORKER_IDLE_MS = 30_000
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
      yield* databaseOperation("inspect", () => assertSqliteFile(path))
      const writable = yield* Effect.promise(() =>
        access(path, fsConstants.W_OK).then(
          () => true,
          () => false
        )
      )
      if (!readOnly && !writable) {
        return yield* Effect.fail(
          RelayDatabaseBrowserError.make({
            code: "read_only_file",
            reason: "The database file is read-only on disk",
          })
        )
      }
      const result = yield* databaseOperation("execute", () =>
        this.#workers.run({ path, readOnly, request })
      )
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

async function assertSqliteFile(path: string) {
  const handle = await open(path, "r")
  try {
    const header = Buffer.alloc(SQLITE_HEADER.byteLength)
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    if (bytesRead === 0) return
    if (header.subarray(0, 4).toString("latin1") === "H:2,") {
      throw databaseError(
        "unsupported_engine",
        "H2 databases can't be browsed yet. Download the file to inspect it locally."
      )
    }
    if (bytesRead < header.byteLength || !header.equals(SQLITE_HEADER)) {
      throw databaseError(
        "not_a_database",
        "This file is not a SQLite database"
      )
    }
  } finally {
    await handle.close()
  }
  // SQLite opens journals by name next to the database. A symlinked journal
  // would let a query write through to a file outside the instance.
  for (const suffix of SQLITE_SIDECARS) {
    const metadata = await lstat(`${path}${suffix}`).catch(() => null)
    if (metadata && !metadata.isFile()) {
      throw databaseError(
        "unsafe_journal",
        `Refusing to open the database because ${suffix.slice(1)} is not a regular file`
      )
    }
  }
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

type PoolRequest = Omit<DatabaseWorkerRequest, "id">

class DatabaseWorkerPool {
  #active = 0
  #idle: { timer: NodeJS.Timeout; worker: Worker } | null = null
  #nextId = 0
  readonly #queue: Array<() => void> = []

  run(request: PoolRequest) {
    return new Promise<unknown>((resolve, reject) => {
      const start = () => {
        this.#active += 1
        const worker = this.#takeWorker()
        const id = ++this.#nextId
        let settled = false
        const finish = (reuse: boolean) => {
          settled = true
          clearTimeout(timer)
          worker.off("message", onMessage)
          worker.off("error", onError)
          worker.off("exit", onExit)
          if (reuse) this.#park(worker)
          else void worker.terminate()
          this.#active -= 1
          this.#queue.shift()?.()
        }
        const onMessage = (message: DatabaseWorkerResponse) => {
          if (settled || message.id !== id) return
          finish(true)
          if (message.ok) resolve(message.result)
          else reject(databaseError(message.code, message.message))
        }
        const onError = (error: Error) => {
          if (settled) return
          finish(false)
          reject(error)
        }
        const onExit = () => {
          if (settled) return
          finish(false)
          reject(databaseError("worker_exit", "The database worker stopped"))
        }
        // Terminating stops JavaScript between rows; a single long SQLite
        // step finishes on its own thread without holding up the Relay.
        const timer = setTimeout(() => {
          if (settled) return
          finish(false)
          reject(
            databaseError(
              "timeout",
              `The database operation took longer than ${WORKER_TIMEOUT_MS / 1000}s and was stopped`
            )
          )
        }, WORKER_TIMEOUT_MS)
        worker.on("message", onMessage)
        worker.once("error", onError)
        worker.once("exit", onExit)
        worker.postMessage({ ...request, id } satisfies DatabaseWorkerRequest)
      }
      if (this.#active < MAX_ACTIVE_WORKERS) start()
      else this.#queue.push(start)
    })
  }

  #takeWorker() {
    if (this.#idle) {
      const { timer, worker } = this.#idle
      clearTimeout(timer)
      this.#idle = null
      worker.ref()
      return worker
    }
    return spawnWorker()
  }

  #park(worker: Worker) {
    if (this.#idle) {
      void worker.terminate()
      return
    }
    worker.unref()
    const timer = setTimeout(() => {
      if (this.#idle?.worker !== worker) return
      this.#idle = null
      void worker.terminate()
    }, WORKER_IDLE_MS)
    timer.unref()
    this.#idle = { timer, worker }
  }
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
