import { readSync, writeSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"

import type {
  DatabaseReadRequest,
  DatabaseWriteRequest,
} from "@workspace/contracts"
import * as Result from "effect/Result"

import {
  DatabaseBrowserError,
  type DatabaseJob,
  openSqliteDatabase,
  sqliteMutate,
  sqliteOverview,
  sqliteQuery,
  sqliteRows,
} from "./database-browser-sqlite.js"
import {
  COMMIT_CHANNEL_FD,
  COMMIT_GRANTED,
  COMMIT_REQUEST,
} from "./database-browser-protocol.js"

export interface DatabaseWorkerRequest {
  path: string
  readOnly: boolean
  request: DatabaseReadRequest | DatabaseWriteRequest
}

export type DatabaseWorkerResponse =
  | { ok: true; result: unknown }
  | { code: string; message: string; ok: false }

// SQLite calls are synchronous and node:sqlite cannot interrupt them, so jobs
// run in this child process: the Relay stops a runaway job by killing it,
// which also releases its locks and rolls back its open transaction.
process.on("message", (message: DatabaseWorkerRequest) => {
  process.send?.(handle(message))
})
process.on("disconnect", () => process.exit(0))

// Before committing, ask the Relay and block until it answers. The Relay only
// kills jobs that have not been granted, so a granted commit always finishes
// and the Relay can report its real outcome.
const job: DatabaseJob = {
  claimCommit() {
    writeSync(COMMIT_CHANNEL_FD, COMMIT_REQUEST)
    const answer = Buffer.alloc(1)
    readSync(COMMIT_CHANNEL_FD, answer, 0, 1, null)
    if (answer.toString() !== COMMIT_GRANTED) {
      throw new DatabaseBrowserError(
        "cancelled",
        "The operation was cancelled, so nothing was saved"
      )
    }
  },
}

function handle({
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
          return sqliteQuery(database, request, { job, writable: !readOnly })
        case "mutate":
          return sqliteMutate(database, request, job)
      }
    })
  )
  if (Result.isSuccess(outcome)) return { ok: true, result: outcome.success }
  const error = outcome.failure
  return {
    code: error instanceof DatabaseBrowserError ? error.code : "sqlite_error",
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
