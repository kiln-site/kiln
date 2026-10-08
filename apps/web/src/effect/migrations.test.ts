import { expect, layer } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"

import { migrations } from "@/migrations"
import { baseline } from "@/migrations/0001_baseline"
import { baselineTables } from "@/migrations/baseline-schema"
import { describeMysql, testDatabaseClient } from "@/test/database"

import { applyMigrations } from "./migrations"

const migrationIds = migrations.map((migration) => migration.id)

describeMysql("database migrations", () => {
  // Drops and rebuilds tables, so it gets a database of its own.
  layer(testDatabaseClient(`${process.env.DB_NAME}_migrations`))((it) => {
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

    const columnTypes = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ dataType: string }>`
        SELECT DISTINCT data_type AS dataType
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND data_type IN ('timestamp', 'datetime', 'decimal')
      `
    })

    it.effect(
      "creates the schema once and recognizes existing installs",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(migrations)
          const [{ count }] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM information_schema.tables
            WHERE table_schema = DATABASE()
          `
          // Baseline, the migration ledger, instance favorites, and notifications.
          expect(count).toBe(baselineTables.length + 3)
          expect(yield* ledger).toEqual(migrationIds)
          // Only better-auth keeps dates, as DATETIME.
          expect((yield* columnTypes).map((row) => row.dataType)).toEqual([
            "datetime",
          ])

          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual(migrationIds)

          // A schema that differs is refused and left unrecorded.
          yield* dropAllTables
          yield* applyMigrations([baseline])
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
      // Rebuilding every table with a time column takes a while.
      120_000
    )

    it.effect(
      "upgrades the latest legacy install to epoch milliseconds",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations([baseline])
          // A legacy install has no ledger and wrote times through a
          // non-UTC session.
          yield* sql`DROP TABLE kiln_schema_migration`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET time_zone = 'America/New_York'`
              yield* sql`
                INSERT INTO kiln_setting
                  (id, setting_key, setting_value, created_at)
                VALUES ('a', 'k', '{}', FROM_UNIXTIME(1790673560.833))
              `
            })
          )

          yield* applyMigrations(migrations)
          const [row] = yield* sql<{ createdAt: number; updatedAt: number }>`
            SELECT created_at AS createdAt, updated_at AS updatedAt
            FROM kiln_setting WHERE id = 'a'
          `
          expect(Number(row.createdAt)).toBe(1790673560833)
          expect(Number(row.updatedAt)).toBeGreaterThan(1_700_000_000_000)
          expect(yield* ledger).toEqual(migrationIds)
          expect((yield* columnTypes).map((row) => row.dataType)).toEqual([
            "datetime",
          ])
        }),
      // Rebuilding every table with a time column takes a while.
      120_000
    )
  })
})
