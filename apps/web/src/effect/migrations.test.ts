import { expect, layer } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"

import { listFileActivityEffect } from "@/lib/file-activity"
import { migrations } from "@/migrations"
import { baseline } from "@/migrations/0001_baseline"
import { fileActivityRoots } from "@/migrations/0009_file_activity_roots"
import { baselineTables } from "@/migrations/baseline-schema"
import { describeMysql, testDatabaseClient } from "@/test/database"
import {
  insertInstance,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

import { Database, makeDatabase } from "./database"
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
          // Baseline, the migration ledger, instance favorites, notifications,
          // tracked system updates, Kiln releases with component versions, and
          // apps.
          expect(count).toBe(baselineTables.length + 7)
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

    it.effect(
      "keeps server file pins and drops each root's with its owner",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const relayId = "relay-one"
          const serverId = "a".repeat(40)
          const appId = "b".repeat(40)
          const activity = (path: string, row: Record<string, unknown>) => ({
            relay_id: relayId,
            path_hash: path.padEnd(64, "0").slice(0, 64),
            path,
            pinned: false,
            last_viewed_at: 1,
            created_at: 1,
            updated_at: 1,
            ...row,
          })
          const list = (root: string) =>
            listFileActivityEffect(relayId, root).pipe(
              Effect.map((result) =>
                result.files.map(({ path, pinned }) => ({ path, pinned }))
              ),
              Effect.provideService(Database, makeDatabase(Effect.succeed(sql)))
            )

          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < fileActivityRoots.id
            )
          )
          yield* insertRelay(relayId)
          yield* insertInstance(relayId, serverId)
          yield* insertRows("file_activity", [
            activity("server.properties", {
              instance_id: serverId,
              pinned: true,
            }),
            activity("logs/latest.log", { instance_id: serverId }),
          ])

          yield* applyMigrations(migrations)
          expect(yield* list(serverId)).toEqual([
            { path: "server.properties", pinned: true },
            { path: "logs/latest.log", pinned: false },
          ])

          yield* insertRows("app", {
            app_id: appId,
            relay_id: relayId,
            name: "app",
            config_ciphertext: "",
            created_by: "user",
            created_at: 1,
            updated_at: 1,
          })
          // Every row names the same columns for one multi-row insert.
          const root = (
            rootId: string,
            instanceId: string | null,
            app: string | null
          ) => ({
            root_id: rootId,
            instance_id: instanceId,
            app_id: app,
          })
          yield* insertRows("file_activity", [
            activity("plugins/", root(serverId, serverId, null)),
            activity("data/", {
              ...root(`app:${appId}`, null, appId),
              pinned: true,
            }),
            activity("etc/hosts", {
              ...root(relayId, null, null),
              pinned: true,
            }),
          ])
          // Only files are recent; directories show only while pinned.
          expect(yield* list(serverId)).toEqual([
            { path: "server.properties", pinned: true },
            { path: "logs/latest.log", pinned: false },
          ])
          expect(yield* list(`app:${appId}`)).toEqual([
            { path: "data/", pinned: true },
          ])

          const roots = Effect.map(
            selectRows<{ root_id: string }>("file_activity"),
            (rows) => [...new Set(rows.map((row) => row.root_id))].sort()
          )
          yield* sql`DELETE FROM kiln_instance WHERE instance_id = ${serverId}`
          expect(yield* roots).toEqual([`app:${appId}`, relayId])
          yield* sql`DELETE FROM kiln_app WHERE app_id = ${appId}`
          expect(yield* roots).toEqual([relayId])
          yield* sql`DELETE FROM kiln_relay WHERE id = ${relayId}`
          expect(yield* roots).toEqual([])
        }),
      120_000
    )
  })
})
