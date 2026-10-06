import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  ScopedCache,
} from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { isSqlError } from "effect/sql/SqlError"
import type { SqlError } from "effect/sql/SqlError"

import { databaseConnectionConfig } from "@/lib/database-config"

import { DatabaseError } from "./errors"

type QueryValue = boolean | Buffer | Date | null | number | string

export interface DatabaseTransaction {
  readonly execute: (
    sql: string,
    values?: Array<QueryValue>
  ) => Effect.Effect<ResultSetHeader, DatabaseError>
  readonly queryRows: <TRow extends RowDataPacket>(
    sql: string,
    values?: Array<QueryValue>
  ) => Effect.Effect<ReadonlyArray<TRow>, DatabaseError>
}

export class Database extends Context.Service<
  Database,
  {
    readonly execute: (
      operation: string,
      sql: string,
      values?: Array<QueryValue>
    ) => Effect.Effect<ResultSetHeader, DatabaseError>
    readonly queryRows: <TRow extends RowDataPacket>(
      operation: string,
      sql: string,
      values?: Array<QueryValue>
    ) => Effect.Effect<ReadonlyArray<TRow>, DatabaseError>
    readonly transaction: <TResult, TError, TRequirements>(
      operation: string,
      run: (
        transaction: DatabaseTransaction
      ) => Effect.Effect<TResult, TError, TRequirements>
    ) => Effect.Effect<TResult, DatabaseError | TError, TRequirements>
  }
>()("kiln/Database") {}

export function databaseClientConfig(
  maxConnections: number
): MysqlClient.MysqlClientConfig {
  const config = databaseConnectionConfig()
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: Redacted.make(config.password),
    maxConnections,
    // Kiln stores times as UTC epoch milliseconds. better-auth's DATETIME
    // columns hold UTC too; mysql2 reads and writes their JS Dates as UTC.
    poolConfig: { connectTimeout: 2_000, timezone: "Z" },
  }
}

const globalDatabase = globalThis as typeof globalThis & {
  kilnDatabaseClient?: Effect.Effect<SqlClient.SqlClient, SqlError>
}

export const DatabaseLive = Layer.effect(Database)(
  Effect.gen(function* () {
    // Development program reloads rebuild the app runtime without disposing
    // the old one, so they share its MySQL pool, like `@/lib/database`.
    const client =
      globalDatabase.kilnDatabaseClient ?? (yield* makeDatabaseClient)
    if (process.env.NODE_ENV !== "production") {
      globalDatabase.kilnDatabaseClient = client
    }
    return makeDatabase(client)
  })
).pipe(Layer.provide(Reactivity.layer))

// Connects on the first query, so effects that never touch MySQL don't wait
// on it. A failed connection isn't cached; the next query tries again.
const makeDatabaseClient = Effect.gen(function* () {
  const reactivity = yield* Reactivity.Reactivity
  const clients = yield* ScopedCache.makeWith({
    lookup: () =>
      Effect.suspend(() => MysqlClient.make(databaseClientConfig(10))).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity)
      ),
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  })
  return ScopedCache.get(clients, "mysql")
})

// Statements inside `transaction` join its connection through Effect SQL's
// transaction context, including nested transactions as savepoints.
export function makeDatabase(
  client: Effect.Effect<SqlClient.SqlClient, SqlError>
) {
  const withClient = <TResult, TError, TRequirements>(
    operation: string,
    use: (
      sql: SqlClient.SqlClient
    ) => Effect.Effect<TResult, TError, TRequirements>
  ) =>
    client.pipe(
      Effect.mapError((cause) => DatabaseError.make({ operation, cause })),
      Effect.flatMap(use)
    )
  const execute = (
    operation: string,
    statement: string,
    values: Array<QueryValue> = []
  ) =>
    withClient(operation, (sql) =>
      databaseQuery(
        operation,
        sql.unsafe(statement, values).raw as Effect.Effect<
          ResultSetHeader,
          SqlError
        >
      )
    )
  // Reads keep mysql2's text protocol; MySQL rejects numeric `LIMIT ?`
  // binds in prepared statements.
  const queryRows = <TRow extends RowDataPacket>(
    operation: string,
    statement: string,
    values: Array<QueryValue> = []
  ) =>
    withClient(operation, (sql) =>
      databaseQuery(operation, sql.unsafe<TRow>(statement, values).unprepared)
    )

  return Database.of({
    execute: (operation, statement, values) =>
      execute(operation, statement, values).pipe(
        Effect.withSpan(`db.${operation}`)
      ),
    queryRows: <TRow extends RowDataPacket>(
      operation: string,
      statement: string,
      values?: Array<QueryValue>
    ) =>
      queryRows<TRow>(operation, statement, values).pipe(
        Effect.withSpan(`db.${operation}`)
      ),
    transaction: (operation, run) =>
      withClient(operation, (sql) =>
        sql
          .withTransaction(
            run({
              execute: (statement, values) =>
                execute(operation, statement, values),
              queryRows: (statement, values) =>
                queryRows(operation, statement, values),
            })
          )
          .pipe(
            Effect.mapError((error) =>
              isSqlError(error)
                ? DatabaseError.make({ operation, cause: error })
                : error
            )
          )
      ).pipe(Effect.withSpan(`db.${operation}`)),
  })
}

function databaseQuery<TResult>(
  operation: string,
  query: Effect.Effect<TResult, SqlError>
): Effect.Effect<TResult, DatabaseError> {
  return query.pipe(
    Effect.mapError((cause) => DatabaseError.make({ operation, cause })),
    // mysql2 cannot cancel a running statement. Wait for active driver work
    // to settle before an interrupt can rollback or release its connection.
    Effect.uninterruptible
  )
}
