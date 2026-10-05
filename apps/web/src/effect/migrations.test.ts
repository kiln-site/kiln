// Runs against a real MySQL database: MYSQL_MIGRATION_TEST=1 with DB_* env
// pointing at a disposable database whose name ends in "migration_test".
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, Redacted } from "effect"
import { SqlClient } from "effect/sql"

import { migrations } from "@/migrations"
import { baselineTables } from "@/migrations/baseline-schema"

import { applyMigrations } from "./migrations"

const enabled = process.env.MYSQL_MIGRATION_TEST === "1"
const database = process.env.DB_NAME ?? ""
if (enabled && !database.endsWith("migration_test")) {
  throw new Error("DB_NAME must be a disposable *migration_test database")
}

describe("database migrations", () => {
  layer(
    MysqlClient.layer({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 3306),
      database,
      username: process.env.DB_USERNAME,
      password: Redacted.make(process.env.DB_PASSWORD ?? ""),
      maxConnections: 2,
    })
  )((it) => {
    const dropAllTables = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const tables = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = DATABASE()
          `
          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          for (const table of tables) yield* sql`DROP TABLE ${sql(table.name)}`
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`
        })
      )
    })

    const ledger = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ id: number }>`
        SELECT id FROM kiln_schema_migration ORDER BY id
      `
      return rows.map((row) => row.id)
    })

    it.effect.skipIf(!enabled)(
      "creates the baseline once and recognizes existing installs",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(migrations)
          const [{ count }] = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM information_schema.tables
          WHERE table_schema = DATABASE()
        `
          expect(count).toBe(baselineTables.length + 1)
          expect(yield* ledger).toEqual([1])

          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual([1])

          // An install from the last legacy release has the tables, no ledger.
          yield* sql`DROP TABLE kiln_schema_migration`
          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual([1])

          // A schema that differs is refused and left unrecorded.
          yield* sql`DROP TABLE kiln_schema_migration`
          yield* sql`ALTER TABLE kiln_setting ADD COLUMN unexpected INT NULL`
          const exit = yield* Effect.exit(applyMigrations(migrations))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(String(exit)).toContain("kiln_setting")
          expect(yield* ledger).toEqual([])

          // So is one whose columns match by name but not by definition, such
          // as an enum missing a value the legacy scripts added.
          yield* sql`ALTER TABLE kiln_setting DROP COLUMN unexpected`
          yield* sql`
            ALTER TABLE kiln_schedule_run MODIFY status
              ENUM('succeeded','partial','failed','noop','interrupted','missed')
              NOT NULL
          `
          const definitionExit = yield* Effect.exit(applyMigrations(migrations))
          expect(Exit.isFailure(definitionExit)).toBe(true)
          expect(String(definitionExit)).toContain("kiln_schedule_run (status)")
          expect(yield* ledger).toEqual([])
        }),
      // Creating 47 tables outlasts the default timeout under a full run.
      120_000
    )
  })
})
