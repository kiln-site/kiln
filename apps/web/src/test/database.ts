import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { describe } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"

import { Database, databaseClientConfig, makeDatabase } from "@/effect/database"
import { applyMigrations } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"
import { migrations } from "@/migrations"

// Runs against real MySQL when KILN_TEST_MYSQL=1 and DB_* point at a server
// that can create `<DB_NAME>_<worker>` databases (CI does this). Otherwise
// these suites are skipped.
export const mysqlEnabled = process.env.KILN_TEST_MYSQL === "1"

export const describeMysql = mysqlEnabled ? describe : describe.skip

// An Effect SQL client for a database on the test server, created if missing.
export function testDatabaseClient(database: string) {
  const config = { ...databaseClientConfig(4), database }
  const create = Effect.gen(function* () {
    const sql = yield* MysqlClient.make({ ...config, database: undefined })
    yield* sql`CREATE DATABASE IF NOT EXISTS ${sql(database)}`
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer))
  return Layer.unwrap(Effect.as(create, MysqlClient.layer(config)))
}

const migratedClient = Layer.effectDiscard(applyMigrations(migrations)).pipe(
  Layer.provideMerge(testDatabaseClient(process.env.DB_NAME ?? ""))
)

// A migrated database for the current worker, exposed both as Effect SQL and
// as Kiln's `Database` service. Shared by every test in a `layer(...)` block;
// call `resetDatabase` at the start of each test.
export const TestDatabase = Layer.effect(
  Database,
  Effect.map(SqlClient.SqlClient, (sql) =>
    makeDatabase(Effect.succeed(sql))
  )
).pipe(Layer.provideMerge(migratedClient))

// Empties every table except the migration ledger.
export const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const ledger = databaseTableName("schema_migration")
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name <> ${ledger}
      `
      yield* sql`SET FOREIGN_KEY_CHECKS = 0`
      for (const table of tables) yield* sql`DELETE FROM ${sql(table.name)}`
      yield* sql`SET FOREIGN_KEY_CHECKS = 1`
    })
  )
})
