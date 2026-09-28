import type { DatabaseSync } from "node:sqlite"
import { parentPort } from "node:worker_threads"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
} from "@workspace/contracts"
import { Result } from "effect"

import {
  DatabaseBrowserError,
  openSqliteDatabase,
  sqliteMutate,
  sqliteOverview,
  sqliteQuery,
  sqliteRows,
} from "./database-browser-sqlite.js"

export interface DatabaseWorkerRequest {
  id: number
  path: string
  readOnly: boolean
  request: DatabaseReadRequest | DatabaseWriteRequest
}

export type DatabaseWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { code: string; id: number; message: string; ok: false }

// SQLite calls are synchronous, so they run here instead of blocking the
// Relay event loop. The parent terminates this worker when a query overruns.
parentPort?.on("message", (message: DatabaseWorkerRequest) => {
  parentPort?.postMessage(handle(message))
})

function handle({
  id,
  path,
  readOnly,
  request,
}: DatabaseWorkerRequest): DatabaseWorkerResponse {
  const outcome = Result.try(() =>
    withDatabase(path, readOnly, (database) => {
      switch (request.action) {
        case "overview":
          return sqliteOverview(database)
        case "rows":
          return sqliteRows(database, request)
        case "query":
          return sqliteQuery(database, request)
        case "mutate":
          return sqliteMutate(database, request)
      }
    })
  )
  if (Result.isSuccess(outcome)) {
    return { id, ok: true, result: outcome.success }
  }
  const error = outcome.failure
  return {
    code: error instanceof DatabaseBrowserError ? error.code : "sqlite_error",
    id,
    message: sqliteErrorMessage(error),
    ok: false,
  }
}

// Every request gets its own connection, closed even when the work throws.
function withDatabase<TResult>(
  path: string,
  readOnly: boolean,
  use: (database: DatabaseSync) => TResult
) {
  const database = openSqliteDatabase(path, readOnly)
  const outcome = Result.try(() => use(database))
  database.close()
  if (Result.isFailure(outcome)) throw outcome.failure
  return outcome.success
}

function sqliteErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The database operation failed"
  if (/readonly database/iu.test(error.message)) {
    return "This database is open read-only"
  }
  if (/database is locked|SQLITE_BUSY/iu.test(error.message)) {
    return "The database is locked by another process. Try again, or stop the server first."
  }
  if (/file is not a database/iu.test(error.message)) {
    return "This file is not a SQLite database"
  }
  return error.message
}
