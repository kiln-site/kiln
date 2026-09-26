import { parentPort } from "node:worker_threads"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
} from "@workspace/contracts"

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
  try {
    const database = openSqliteDatabase(path, readOnly)
    try {
      switch (request.action) {
        case "overview":
          return { id, ok: true, result: sqliteOverview(database) }
        case "rows":
          return { id, ok: true, result: sqliteRows(database, request) }
        case "query":
          return { id, ok: true, result: sqliteQuery(database, request) }
        case "mutate":
          return { id, ok: true, result: sqliteMutate(database, request) }
      }
    } finally {
      database.close()
    }
  } catch (error) {
    return {
      code: error instanceof DatabaseBrowserError ? error.code : "sqlite_error",
      id,
      message: sqliteErrorMessage(error),
      ok: false,
    }
  }
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
