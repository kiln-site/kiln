import { expect, layer } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"

import { listFileActivityEffect } from "@/lib/file-activity"
import { migrations } from "@/migrations"
import { baseline } from "@/migrations/0001_baseline"
import { fileActivityRoots } from "@/migrations/0009_file_activity_roots"
import { incrementalBackupArtifacts } from "@/migrations/0013_incremental_backup_artifacts"
import { domainZones } from "@/migrations/0015_domain_zones"
import { baselineTables } from "@/migrations/baseline-schema"
import { describeMysql, testDatabaseClient } from "@/test/database"
import {
  insertBackup,
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
          // Kiln releases with component versions, apps, domain opt-outs,
          // vanity domain zones, and GitHub connections, syncs, and runs.
          expect(count).toBe(baselineTables.length + 11)
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
    it.effect(
      "finishes incremental deletes left behind by legacy artifacts",
      () =>
        Effect.gen(function* () {
          const artifact = (
            id: string,
            backupId: string,
            destinationKey: string,
            createdAt: number
          ) => ({
            id,
            backup_id: backupId,
            destination_key: destinationKey,
            status: "available",
            created_at: createdAt,
            updated_at: createdAt,
          })
          const ids = {
            forgotten: "10000000-0000-4000-8000-000000000001",
            kept: "10000000-0000-4000-8000-000000000002",
            full: "10000000-0000-4000-8000-000000000003",
            promoted: "10000000-0000-4000-8000-000000000004",
          }

          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < incrementalBackupArtifacts.id
            )
          )
          // The legacy copy predates the restic artifact, so a task
          // dispatched with it first reported only the copy.
          const incremental = [
            [ids.forgotten, { status: "deleted", deleted_at: 400 }, {}],
            [ids.kept, {}, {}],
            [
              ids.promoted,
              { bytes: 512, completed_at: 250 },
              { status: "queued" },
            ],
          ] as const
          for (const [id, phantom, snapshot] of incremental) {
            yield* insertBackup(id, {
              artifact_kind: "restic_snapshot",
              backup_mode: "incremental",
            })
            yield* insertRows("backup_artifact", [
              {
                ...artifact(id, id, "local", 1),
                bytes: null,
                completed_at: null,
                deleted_at: null,
                ...phantom,
              },
              {
                ...artifact(`3${id.slice(1)}`, id, "restic", 2),
                bytes: null,
                completed_at: null,
                deleted_at: null,
                ...snapshot,
              },
            ])
          }
          yield* insertBackup(ids.full)
          yield* insertRows(
            "backup_artifact",
            artifact(ids.full, ids.full, "local", 1)
          )
          yield* insertRows("backup_task", {
            id: "20000000-0000-4000-8000-000000000001",
            backup_id: ids.forgotten,
            task_kind: "delete",
            status: "succeeded",
            finished_at: 400,
            created_at: 300,
            updated_at: 400,
          })

          yield* applyMigrations(migrations)

          const backups = new Map(
            (yield* selectRows<{
              deleted_at: number | null
              id: string
              status: string
            }>("backup")).map((row) => [row.id, row])
          )
          expect(backups.get(ids.forgotten)?.status).toBe("deleted")
          expect(Number(backups.get(ids.forgotten)?.deleted_at)).toBe(400)
          expect(backups.get(ids.kept)?.status).toBe("available")
          expect(backups.get(ids.promoted)?.status).toBe("available")
          expect(backups.get(ids.full)?.status).toBe("available")
          const artifactRows = yield* selectRows<{
            backup_id: string
            bytes: number | null
            destination_key: string
            status: string
          }>("backup_artifact")
          expect(artifactRows).toHaveLength(4)
          const artifacts = new Map(
            artifactRows.map((row) => [
              row.backup_id,
              [row.destination_key, row.status, Number(row.bytes)],
            ])
          )
          expect(artifacts).toEqual(
            new Map([
              [ids.forgotten, ["restic", "deleted", 0]],
              [ids.kept, ["restic", "available", 0]],
              [ids.promoted, ["restic", "available", 512]],
              [ids.full, ["local", "available", 0]],
            ])
          )
        }),
      120_000
    )

    it.effect(
      "keeps a single-domain vanity setup and its game server domains",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id < domainZones.id)
          )
          yield* insertRows("domain_integration", {
            id: "cloudflare",
            provider: "cloudflare",
            domain: "play.kiln.site",
            zone_id: "a".repeat(32),
            zone_name: "kiln.site",
            api_token_ciphertext: "ciphertext",
            blacklist_patterns: "[]",
            enabled: true,
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("instance_domain", {
            relay_id: "relay-one",
            instance_id: "b".repeat(40),
            integration_id: "cloudflare",
            vanity_label: "amber-anvil",
            domain: "play.kiln.site",
            public_host: "203.0.113.10",
            public_port: 25_565,
            address_record_id: "c".repeat(32),
            address_record_type: "A",
            status: "active",
            created_at: 0,
            updated_at: 0,
          })

          yield* applyMigrations(migrations)

          expect(
            yield* selectRows<{
              domain: string
              is_default: number
              zone_id: string
              zone_name: string
            }>("domain_zone")
          ).toMatchObject([
            {
              domain: "play.kiln.site",
              is_default: 1,
              zone_id: "a".repeat(32),
              zone_name: "kiln.site",
            },
          ])
          expect(
            yield* selectRows<{ assignment_strategy: string }>(
              "domain_integration"
            )
          ).toMatchObject([
            { api_token_ciphertext: "ciphertext", assignment_strategy: "default" },
          ])
          const [assignment] = yield* selectRows<{
            address_record_id: string
            id: string
            is_primary: number
            vanity_label: string
          }>("instance_domain")
          expect(assignment).toMatchObject({
            address_record_id: "c".repeat(32),
            is_primary: 1,
            vanity_label: "amber-anvil",
          })
          expect(assignment?.id).toMatch(/^[0-9a-f-]{36}$/u)
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )
  })
})
