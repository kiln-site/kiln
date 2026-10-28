import { expect, layer } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"

import { listFileActivityEffect } from "@/lib/file-activity"
import { migrations } from "@/migrations"
import { baseline } from "@/migrations/0001_baseline"
import { fileActivityRoots } from "@/migrations/0009_file_activity_roots"
import { incrementalBackupArtifacts } from "@/migrations/0013_incremental_backup_artifacts"
import { domainZones } from "@/migrations/0015_domain_zones"
import { securityReports } from "@/migrations/0031_security_reports"
import { cloudflareConnections } from "@/migrations/0035_cloudflare_connections"
import { tailscaleMemberIds } from "@/migrations/0039_tailscale_member_ids"
import { backupResourceTargets } from "@/migrations/0042_backup_resource_targets"
import { resourceDeletions } from "@/migrations/0044_resource_deletions"
import { scheduleAppTargets } from "@/migrations/0046_schedule_app_targets"
import { baselineTables } from "@/migrations/baseline-schema"
import { describeMysql, testDatabaseClient } from "@/test/database"
import {
  insertBackup,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
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
          // vanity domain zones, GitHub connections, syncs, and runs, audit
          // events, apps' GitHub sources and deployments, image apps'
          // updates, push subscriptions, Relay joins, and the security
          // checks' targets, inventories, findings, vulnerabilities, and
          // alerts, game server migrations, icons, web hostnames, and
          // Relays' handovers of Apps' database connections. The two
          // final-delete tables became one of resource deletions.
          expect(count).toBe(baselineTables.length + 31)
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
            yield* selectRows<{ api_token_ciphertext: string }>(
              "domain_integration"
            )
          ).toMatchObject([
            { api_token_ciphertext: "ciphertext", owner_id: null },
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
    it.effect(
      "folds each person's vulnerability notifications into one report",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id < securityReports.id)
          )
          const resource = (id: string) => ({
            id,
            name: `App ${id}`,
            relayId: "relay-a",
            type: "app",
          })
          const vulnerabilities = (
            id: string,
            userId: string,
            data: Record<string, unknown>,
            row: Record<string, unknown> = {}
          ) => ({
            id,
            user_id: userId,
            kind: "security.vulnerabilities",
            source_key: `security:${id}`,
            data: JSON.stringify({
              component: null,
              fixable: 0,
              knownExploited: 0,
              severity: "high",
              top: {
                fixedVersion: null,
                id: "CVE-1",
                packageName: "openssl",
                packageVersion: "1",
              },
              ...data,
            }),
            created_at: 1_000,
            read_at: null,
            dismissed_at: null,
            ...row,
          })
          yield* insertRows("notification", [
            vulnerabilities("a1", "user-a", {
              count: 2,
              resource: resource("one"),
            }),
            vulnerabilities(
              "a2",
              "user-a",
              {
                count: 3,
                knownExploited: 1,
                resource: resource("two"),
                severity: "critical",
              },
              { created_at: 2_000, read_at: 2_500 }
            ),
            vulnerabilities(
              "a3",
              "user-a",
              { count: 1, resource: resource("one") },
              { created_at: 3_000 }
            ),
            // Cleared ones stay cleared and out of the report.
            vulnerabilities(
              "a4",
              "user-a",
              { count: 9, resource: resource("three") },
              { read_at: 1_500, dismissed_at: 1_500 }
            ),
            vulnerabilities(
              "b1",
              "user-b",
              { count: 1, resource: resource("one") },
              { read_at: 4_000 }
            ),
          ])

          yield* applyMigrations(migrations)

          const rows = yield* selectRows<{
            created_at: number
            data: unknown
            dismissed_at: number | null
            kind: string
            read_at: number | null
            user_id: string
          }>("notification")
          expect(
            rows
              .filter((row) => row.kind === "security.vulnerabilities")
              .every((row) => row.dismissed_at !== null)
          ).toBe(true)
          const reports = rows
            .filter((row) => row.kind === "security.report")
            .map((row) => ({
              createdAt: Number(row.created_at),
              data:
                typeof row.data === "string" ? JSON.parse(row.data) : row.data,
              dismissedAt: row.dismissed_at,
              readAt: row.read_at === null ? null : Number(row.read_at),
              userId: row.user_id,
            }))
            .sort((a, b) => a.userId.localeCompare(b.userId))
          expect(reports).toEqual([
            {
              createdAt: 3_000,
              data: {
                count: 6,
                knownExploited: 1,
                resources: [resource("one"), resource("two")],
                severity: "critical",
              },
              dismissedAt: null,
              readAt: null,
              userId: "user-a",
            },
            {
              createdAt: 1_000,
              data: {
                count: 1,
                knownExploited: 0,
                resources: [resource("one")],
                severity: "high",
              },
              dismissedAt: null,
              readAt: 4_000,
              userId: "user-b",
            },
          ])
        }),
      120_000
    )

    it.effect(
      "keeps every schedule's targets when schedules learn to target Apps",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < scheduleAppTargets.id
            )
          )
          yield* insertRelay("relay-a")
          const scheduleId = "8d4b0a77-6a0e-4d36-9c11-3b1f4f5e2a10"
          yield* insertRows("schedule", {
            id: scheduleId,
            name: "Nightly",
            cron_expression: "0 0 * * *",
            timezone: "UTC",
            created_by: "user-a",
            created_at: 1_000,
            updated_at: 1_000,
          })
          const target = (kind: string, id: string) => ({
            schedule_id: scheduleId,
            relay_id: "relay-a",
            target_kind: kind,
            target_id: id,
            target_name: `${kind} ${id}`,
            created_at: 1_000,
          })
          const stored = [
            target("instance", "server-a"),
            target("database", "database-a"),
            target("relay", "relay-a"),
          ]
          yield* insertRows("schedule_target", stored)

          yield* applyMigrations(migrations)
          yield* insertRows("schedule_target", target("app", "app-a"))

          const rows = yield* selectRows<{
            target_id: string
            target_kind: string
            target_name: string
          }>("schedule_target")
          expect(
            rows
              .map(({ target_id, target_kind, target_name }) => ({
                target_id,
                target_kind,
                target_name,
              }))
              .sort((a, b) => a.target_id.localeCompare(b.target_id))
          ).toEqual([
            { target_id: "app-a", target_kind: "app", target_name: "app app-a" },
            ...stored.map(({ target_id, target_kind, target_name }) => ({
              target_id,
              target_kind,
              target_name,
            })),
          ].sort((a, b) => a.target_id.localeCompare(b.target_id)))
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )

    it.effect(
      "makes the one Cloudflare connection the shared one, keeping its reserved names",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < cloudflareConnections.id
            )
          )
          yield* insertRows("domain_integration", {
            id: "cloudflare",
            provider: "cloudflare",
            api_token_ciphertext: "ciphertext",
            assignment_strategy: "balanced",
            blacklist_patterns: JSON.stringify(["^staff-"]),
            enabled: false,
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("domain_zone", {
            domain: "play.kiln.site",
            integration_id: "cloudflare",
            zone_id: "a".repeat(32),
            zone_name: "kiln.site",
            is_default: true,
            enabled: true,
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("instance_domain", {
            id: "00000000-0000-4000-8000-000000000001",
            relay_id: "relay-one",
            instance_id: "b".repeat(40),
            is_primary: true,
            integration_id: "cloudflare",
            vanity_label: "survival",
            domain: "play.kiln.site",
            public_host: "relay-one.example",
            public_port: 25_565,
            status: "active",
            created_at: 0,
            updated_at: 0,
          })

          yield* applyMigrations(migrations)

          // The game server keeps its address, which no web route can take.
          expect(yield* selectRows("hostname_claim")).toMatchObject([
            {
              hostname: "survival.play.kiln.site",
              resource_id: "b".repeat(40),
              resource_type: "instance",
            },
          ])
          const [connection] = yield* selectRows<{
            blacklist_patterns: unknown
          }>("domain_integration")
          expect(connection).toMatchObject({
            api_token_ciphertext: "ciphertext",
            id: "cloudflare",
            owner_id: null,
          })
          const patterns = connection?.blacklist_patterns
          expect(
            typeof patterns === "string" ? JSON.parse(patterns) : patterns
          ).toEqual(["^staff-"])
          // Automatic addresses were off, so its domain stops taking new ones
          // but keeps the addresses on it.
          expect(
            yield* selectRows<{ domain: string }>("domain_zone")
          ).toMatchObject([
            {
              domain: "play.kiln.site",
              enabled: 0,
              integration_id: "cloudflare",
            },
          ])
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )

    it.effect(
      "rewrites Tailscale deployments' bindings with typed members, once, and leaves what it can't read",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < tailscaleMemberIds.id
            )
          )
          const networkId = "c".repeat(40)
          const server = "a".repeat(40)
          const appMember = `app:${"b".repeat(40)}:web`
          const deployment = (bindings: unknown) =>
            JSON.stringify({
              bindings,
              domain: "test",
              hostname: "private-network",
              id: networkId,
              name: "Private Network",
              relayName: "K100",
              subnet: "10.165.57.0/24",
            })
          const binding = (member: Record<string, string>) => ({
            address: "10.165.57.10",
            enabled: true,
            hostname: "paper",
            ...member,
          })
          yield* insertRows("tailscale_network", {
            id: networkId,
            name: "Private Network",
            domain: "test",
            created_at: 0,
            updated_at: 0,
          })
          const saved = {
            legacy: deployment([
              binding({ instanceId: server }),
              binding({ instanceId: appMember, hostname: "web" }),
            ]),
            typed: deployment([binding({ memberId: `instance:${server}` })]),
            unreadable: "{not json",
          }
          for (const [relay, value] of Object.entries(saved)) {
            yield* sql`
              INSERT INTO ${sql("kiln_tailscale_network_deployment")}
                (network_id, relay_id, deployment, cleanup_next_attempt_at,
                 observed_at, updated_at)
              VALUES (${networkId}, ${relay.padEnd(43, "r")}, ${value}, 1, 1, 1234)
            `.pipe(
              // An unreadable row only gets past MySQL's own JSON check as
              // a valid string.
              Effect.catch(
                () =>
                  sql`
                  INSERT INTO ${sql("kiln_tailscale_network_deployment")}
                    (network_id, relay_id, deployment, cleanup_next_attempt_at,
                     observed_at, updated_at)
                  VALUES (${networkId}, ${relay.padEnd(43, "r")}, ${JSON.stringify(value)}, 1, 1, 1234)
                `
              )
            )
          }
          const deployments = Effect.map(
            selectRows<{
              deployment: unknown
              relay_id: string
              updated_at: unknown
            }>("tailscale_network_deployment"),
            (rows) =>
              Object.fromEntries(
                rows.map((row) => [
                  row.relay_id.slice(0, row.relay_id.indexOf("r")),
                  { deployment: row.deployment, updatedAt: row.updated_at },
                ])
              )
          )
          const before = yield* deployments

          yield* applyMigrations(migrations)
          const after = yield* deployments
          const legacy = after.legacy?.deployment
          expect(
            (
              (typeof legacy === "string" ? JSON.parse(legacy) : legacy) as {
                bindings: unknown
              }
            ).bindings
          ).toEqual([
            binding({ memberId: `instance:${server}` }),
            binding({ memberId: appMember, hostname: "web" }),
          ])
          expect(after.legacy?.updatedAt).toEqual(before.legacy?.updatedAt)
          expect(after.typed).toEqual(before.typed)
          expect(after.unreadable).toEqual(before.unreadable)

          // A retry after a crash changes nothing more.
          yield* tailscaleMemberIds.run
          expect(yield* deployments).toEqual(after)
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )

    it.effect(
      "keeps every backup row while backups take Apps and volumes as targets",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < backupResourceTargets.id
            )
          )
          yield* insertRelay("relay-a")
          yield* insertBackup("00000000-0000-4000-8000-000000000001", {
            relay_id: "relay-a",
            target_id: "inst-a",
          })
          yield* insertRows("backup_policy", {
            relay_id: "relay-a",
            target_kind: "database",
            target_id: "db-a",
            exclude_patterns: "[]",
            quantity_limit: 3,
            created_at: 1_000,
            updated_at: 1_000,
          })
          yield* applyMigrations(migrations)

          expect(
            yield* selectRows<Record<string, unknown>>("backup")
          ).toMatchObject([
            {
              artifact_kind: "archive",
              consistency: null,
              target_id: "inst-a",
              target_kind: "instance",
            },
          ])
          expect(yield* selectRows("backup_policy")).toMatchObject([
            { quantity_limit: 3, target_id: "db-a", target_kind: "database" },
          ])
          // An App's volume: its App's ID, then its name in Compose.
          const volume = `${"a".repeat(40)}/${"v".repeat(159)}`
          yield* insertBackup("00000000-0000-4000-8000-000000000002", {
            artifact_kind: "tar_archive",
            consistency: "stopped",
            relay_id: "relay-a",
            target_id: volume,
            target_kind: "volume",
          })
          yield* insertRows("backup_policy", {
            relay_id: "relay-a",
            target_kind: "app",
            target_id: "a".repeat(40),
            exclude_patterns: "[]",
            created_at: 1_000,
            updated_at: 1_000,
          })
          expect(
            (yield* selectRows<{ target_id: string }>("backup")).map(
              (row) => row.target_id
            )
          ).toContain(volume)
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )

    it.effect(
      "carries final deletions over as resource deletions, reviving none that finished",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const finalDelete = (
            table: string,
            targetId: string,
            status: string,
            row: Record<string, unknown> = {}
          ) =>
            insertRows(table, {
              relay_id: "relay-one",
              target_id: targetId,
              backup_id: `backup-${targetId.slice(0, 1)}`,
              requested_by: "user-one",
              status,
              error: null,
              created_at: 1_000,
              updated_at: 2_000,
              ...row,
            })
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter(
              (migration) => migration.id < resourceDeletions.id
            )
          )
          yield* insertRelay("relay-one")
          yield* insertUser("user-one")
          for (const id of ["a", "b", "c", "d", "e"]) {
            yield* insertBackup(`backup-${id}`, { relay_id: "relay-one" })
          }
          yield* finalDelete(
            "backup_final_delete",
            "a".repeat(40),
            "backing_up"
          )
          yield* finalDelete("backup_final_delete", "b".repeat(40), "completed")
          yield* finalDelete(
            "backup_final_database_delete",
            "c".repeat(40),
            "failed",
            {
              error: "Relay disk is full",
            }
          )
          yield* finalDelete(
            "backup_final_database_delete",
            "d".repeat(40),
            "deleting"
          )
          // Its Relay was removed since: nothing to delete it on.
          yield* finalDelete(
            "backup_final_delete",
            "e".repeat(40),
            "backing_up",
            {
              relay_id: "relay-gone",
            }
          )

          yield* applyMigrations(migrations)
          // Run again, as after a stop partway: nothing changes.
          yield* resourceDeletions.run

          const rows = yield* sql<{
            attempt: number
            backup_id: string
            error: string | null
            final_backup: number
            relay_deleted_at: number | null
            resource_id: string
            resource_kind: string
            status: string
          }>`
            SELECT resource_kind, resource_id, status, backup_id, error,
                   final_backup, attempt, relay_deleted_at
            FROM kiln_resource_deletion ORDER BY resource_id
          `
          expect(
            rows.map((row) => ({
              ...row,
              attempt: Number(row.attempt),
              final_backup: Number(row.final_backup),
              relay_deleted_at:
                row.relay_deleted_at === null
                  ? null
                  : Number(row.relay_deleted_at),
            }))
          ).toEqual([
            {
              attempt: 1,
              backup_id: "backup-a",
              error: null,
              final_backup: 1,
              relay_deleted_at: null,
              resource_id: "a".repeat(40),
              resource_kind: "instance",
              status: "backing_up",
            },
            {
              attempt: 1,
              backup_id: "backup-b",
              error: null,
              final_backup: 1,
              // Done: never deleted, or cleaned up, again.
              relay_deleted_at: 2_000,
              resource_id: "b".repeat(40),
              resource_kind: "instance",
              status: "completed",
            },
            {
              attempt: 1,
              backup_id: "backup-c",
              error: "Relay disk is full",
              final_backup: 1,
              relay_deleted_at: null,
              resource_id: "c".repeat(40),
              resource_kind: "database",
              status: "failed",
            },
            {
              attempt: 1,
              backup_id: "backup-d",
              error: null,
              final_backup: 1,
              relay_deleted_at: null,
              resource_id: "d".repeat(40),
              resource_kind: "database",
              status: "deleting",
            },
          ])
          const [{ count }] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name IN ('kiln_backup_final_delete',
                                 'kiln_backup_final_database_delete')
          `
          expect(Number(count)).toBe(0)

          // As an earlier run of it left them, before it took the Relay
          // deletion's start, and with one start recorded since.
          yield* sql`
            UPDATE kiln_resource_deletion SET relay_deleting_at = NULL
            WHERE resource_id = ${"d".repeat(40)}
          `
          yield* sql`
            UPDATE kiln_resource_deletion SET relay_deleting_at = 5
            WHERE resource_id = ${"b".repeat(40)}
          `
          yield* resourceDeletions.run
          const starts = yield* sql<{
            relay_deleting_at: number | null
            resource_id: string
          }>`
            SELECT resource_id, relay_deleting_at
            FROM kiln_resource_deletion ORDER BY resource_id
          `
          expect(
            starts.map((row) => [
              row.resource_id.slice(0, 1),
              row.relay_deleting_at === null
                ? null
                : Number(row.relay_deleting_at),
            ])
          ).toEqual([
            ["a", null],
            ["b", 5],
            ["c", null],
            ["d", 2_000],
          ])
          expect(yield* ledger).toEqual(migrationIds)
        }),
      120_000
    )
  })
})
