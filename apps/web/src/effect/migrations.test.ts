import { describe, expect, layer } from "@effect/vitest"
import { migratedInstanceId } from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { databaseTableName } from "@/lib/database-config"
import { migrations } from "@/migrations"
import { explicitBackupDestinations } from "@/migrations/0054_explicit_backup_destinations"
import { instanceIds } from "@/migrations/0058_instance_ids"
import { describeMysql, testDatabaseClient } from "@/test/database"

import { applyMigrations } from "./migrations"

const migrationIds = migrations.map((migration) => migration.id)

// Building every table takes seconds alone, and minutes beside other schema
// builds on the box's MySQL.
const schemaBuildTimeout = 300_000

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

    it.effect(
      "builds the schema on an empty database, and once only",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual(migrationIds)

          // Every start applies migrations; a built schema stays as it is.
          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual(migrationIds)
        }),
      // Building every table takes a while.
      schemaBuildTimeout
    )

    it.effect(
      "queues each App deploy a request still asked for, once",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth that kept App deploy requests left them.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 49)
          )
          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          yield* sql`INSERT INTO kiln_app_deployment_request
              (app_id, relay_id, push, poll, image_update, requested_at)
            VALUES (${"a".repeat(40)}, ${"r".repeat(43)}, 1, 0, 0, 5),
                   (${"b".repeat(40)}, ${"r".repeat(43)}, 0, 0, 1, 6)`
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`

          yield* applyMigrations(migrations)
          const queued = yield* sql<{
            input: unknown
            queue_key: string
            state: string
          }>`
            SELECT input, queue_key, state FROM kiln_operation
             WHERE kind = 'app.deploy' ORDER BY queue_key
          `
          expect(
            queued.map((row) => ({
              ...row,
              input:
                typeof row.input === "string"
                  ? JSON.parse(row.input)
                  : row.input,
            }))
          ).toEqual([
            {
              input: {
                appId: "a".repeat(40),
                relayId: "r".repeat(43),
                requestedBy: null,
                trigger: "push",
              },
              queue_key: `${"r".repeat(43)}/${"a".repeat(40)}`,
              state: "waiting",
            },
            {
              input: {
                appId: "b".repeat(40),
                relayId: "r".repeat(43),
                requestedBy: null,
                trigger: "update",
              },
              queue_key: `${"r".repeat(43)}/${"b".repeat(40)}`,
              state: "waiting",
            },
          ])
          const [left] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name = 'kiln_app_deployment_request'
          `
          expect(Number(left?.count)).toBe(0)
        }),
      schemaBuildTimeout
    )

    it.effect(
      "settles what leaned on a preferred destination before dropping it",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 53)
          )
          const relay = "r".repeat(43)
          const storage = "11111111-1111-4111-8111-111111111111"
          const preferred = "a".repeat(40)
          const unset = "b".repeat(40)
          const chosen = "c".repeat(40)
          const options = (deleteSource: unknown, backup: unknown = null) =>
            JSON.stringify({ backup, deleteSource })
          const operationInput = (instanceId: string, moved: string) =>
            JSON.stringify({
              options: JSON.parse(moved),
              source: { instanceId, name: "Survival", relayId: relay },
            })

          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          yield* sql`INSERT INTO kiln_backup_storage
              (id, name, endpoint, region, bucket, access_key_id_ciphertext,
               secret_access_key_ciphertext, created_at, updated_at)
            VALUES (${storage}, 'Bucket', 'https://s3.example.test',
                    'us-east-1', 'backups', 'x', 'x', 0, 0)`
          yield* sql`INSERT INTO kiln_backup_policy
              (relay_id, target_kind, target_id, storage_id, exclude_patterns,
               created_at, updated_at)
            VALUES (${relay}, 'instance', ${preferred}, ${storage}, '[]', 0, 0)`
          const moves = [
            ["preferred", preferred, options({}, {})],
            ["unset", unset, options({})],
            ["chosen", chosen, options({ storageId: storage })],
            ["kept", preferred, options(null)],
          ] as const
          for (const [id, instanceId, moved] of moves) {
            yield* sql`INSERT INTO kiln_server_migration
                (id, requested_by, actor, mode, source_relay_id,
                 source_instance_id, source_name, destination_relay_id,
                 destination_instance_id, destination_name, create_key,
                 options, state, step, created_at, updated_at)
              VALUES (${id}, 'someone', '{}', 'migrate', ${relay},
                      ${instanceId}, 'Survival', ${relay}, ${"d".repeat(40)},
                      'Copy', ${id}, ${moved}, 'running', 'copy', 0, 0)`
            yield* sql`INSERT INTO kiln_operation
                (id, kind, version, input, state, created_at, updated_at)
              VALUES (${id}, 'server.migration', 1,
                      ${operationInput(instanceId, moved)}, 'running', 0, 0)`
          }
          const step = { destination: { kind: "local" } }
          yield* sql`INSERT INTO kiln_schedule_action
              (id, schedule_id, position, action_type, action_config,
               created_at)
            VALUES ('saved', 's', 0, 'backup', ${JSON.stringify(step)}, 0),
                   ('bare', 's', 1, 'backup', '{"name":"Nightly"}', 0),
                   ('other', 's', 2, 'wait', '{"seconds":5}', 0)`
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`

          yield* applyMigrations(migrations)

          // Stopped after settling, with the column still there and saying
          // something else now: what was settled stays. Then run once more
          // with the column gone.
          yield* sql`ALTER TABLE kiln_backup_policy
            ADD COLUMN storage_id char(36) DEFAULT NULL`
          yield* explicitBackupDestinations.run
          yield* explicitBackupDestinations.run

          const json = (saved: unknown) =>
            (typeof saved === "string" ? JSON.parse(saved) : saved) as {
              backup?: { storageId?: string | null } | null
              deleteSource?: { storageId?: string | null } | null
              options?: { deleteSource?: { storageId?: string | null } | null }
            }
          const rows = yield* sql<{ id: string; options: unknown }>`
            SELECT id, options FROM kiln_server_migration ORDER BY id
          `
          expect(
            Object.fromEntries(
              rows.map((row) => [row.id, json(row.options).deleteSource])
            )
          ).toEqual({
            chosen: { storageId: storage },
            kept: null,
            preferred: { storageId: storage },
            unset: { storageId: null },
          })
          expect(
            json(rows.find((row) => row.id === "preferred")?.options).backup
          ).toEqual({ storageId: storage })
          // The running steps read the operation's own copy.
          const operations = yield* sql<{ id: string; input: unknown }>`
            SELECT id, input FROM kiln_operation
             WHERE kind = 'server.migration' ORDER BY id
          `
          expect(
            Object.fromEntries(
              operations.map((row) => [
                row.id,
                json(row.input).options?.deleteSource,
              ])
            )
          ).toEqual({
            chosen: { storageId: storage },
            kept: null,
            preferred: { storageId: storage },
            unset: { storageId: null },
          })

          const actions = yield* sql<{ id: string; action_config: unknown }>`
            SELECT id, action_config FROM kiln_schedule_action ORDER BY id
          `
          expect(
            Object.fromEntries(
              actions.map((row) => [
                row.id,
                typeof row.action_config === "string"
                  ? JSON.parse(row.action_config)
                  : row.action_config,
              ])
            )
          ).toEqual({
            bare: { destination: { kind: "local" }, name: "Nightly" },
            other: { seconds: 5 },
            saved: step,
          })

          const [column] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'kiln_backup_policy'
               AND column_name = 'storage_id'
          `
          expect(Number(column?.count)).toBe(0)
        }),
      schemaBuildTimeout
    )

    describe("an update whose migration doesn't finish", () => {
      // Every table's definition and rows, as Hearth's release finds them.
      const database = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{ name: string }>`
          SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = DATABASE() ORDER BY table_name
        `
        const state: Record<string, { definition: string; rows: unknown }> =
          {}
        for (const { name } of tables) {
          const [created] = yield* sql.unsafe<Record<string, string>>(
            `SHOW CREATE TABLE \`${name}\``
          )
          state[name] = {
            definition: created?.["Create Table"] ?? "",
            rows: yield* sql.unsafe(`SELECT * FROM \`${name}\` ORDER BY 1`),
          }
        }
        return state
      })
      const notification = (id: string, kind: string) => ({
        created_at: 1,
        data: "{}",
        id,
        kind,
        read_at: null,
        source_key: `${kind}:${id}`,
        user_id: "user-a",
      })
      // Changes the schema and rows the way a migration can before it
      // stops: a new column, a new table, rows changed and deleted.
      const halfDone = (stop: Effect.Effect<never, unknown>) => ({
        id: migrationIds.at(-1)! + 1,
        name: "half_done",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`ALTER TABLE kiln_notification ADD COLUMN extra int NULL`
          yield* sql`CREATE TABLE kiln_half_done (id int PRIMARY KEY)`
          yield* sql`UPDATE kiln_notification SET kind = 'changed'`
          yield* sql`DELETE FROM kiln_notification WHERE id = 'b'`
          return yield* stop
        }),
      })
      const migrated = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* dropAllTables
        yield* applyMigrations(migrations)
        yield* sql`INSERT INTO kiln_notification ${sql.insert([
          notification("a", "app.deployed"),
          notification("b", "kiln.updated"),
        ])}`
        return yield* database
      })

      it.effect(
        "puts the database back when a migration fails",
        () =>
          Effect.gen(function* () {
            const before = yield* migrated

            const exit = yield* Effect.exit(
              applyMigrations([
                ...migrations,
                halfDone(Effect.fail(new Error("broken migration"))),
              ])
            )

            expect(exit._tag).toBe("Failure")
            expect(yield* database).toEqual(before)
          }),
        schemaBuildTimeout
      )

      it.effect(
        "puts it back on the next start when the process stopped",
        () =>
          Effect.gen(function* () {
            const before = yield* migrated
            yield* Effect.exit(
              applyMigrations([...migrations, halfDone(Effect.interrupt)])
            )

            // The release it rolled back to starts.
            yield* applyMigrations(migrations)

            expect(yield* database).toEqual(before)
          }),
        schemaBuildTimeout
      )
    })

    describe("a Tailscale network whose old ID is also a game server's", () => {
      const fingerprint = "r".repeat(43)
      const legacyNetwork = "5c".repeat(20)
      const ids = Effect.promise(async () => ({
        network: await migratedInstanceId({
          id: legacyNetwork,
          kind: "tailscale",
        }),
        relay: await migratedInstanceId({ fingerprint, kind: "relay" }),
        server: await migratedInstanceId({
          id: legacyNetwork,
          kind: "server",
          relayFingerprint: fingerprint,
        }),
      }))
      const insertRelay = (id: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO kiln_relay
              (id, name, hostname, browser_origin, relay_public_key, client_id,
               client_public_key, client_private_key_ciphertext, client_role,
               client_actions, created_at, updated_at)
            VALUES (${id}, 'Q02', 'q02.test', 'https://q02.test', 'key',
                    ${"c".repeat(43)}, 'key', 'x', 'full_access', '[]', 0, 0)`
        })
      // The network, its deployment, and the game server its container
      // shows up as, by what they're named in the database.
      const insertNetwork = (network: string, server: string, relay: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO kiln_tailscale_network
              (id, name, domain, created_at, updated_at)
            VALUES (${network}, 'Tailnet', 'kiln', 0, 0)`
          yield* sql`INSERT INTO kiln_tailscale_network_deployment
              (network_id, relay_id, deployment, cleanup_next_attempt_at,
               observed_at, updated_at)
            VALUES (${server}, ${relay}, ${JSON.stringify({ id: server })},
                    0, 0, 0)`
          yield* sql`INSERT INTO kiln_instance
              (relay_id, instance_id, created_at, updated_at)
            VALUES (${relay}, ${server}, 0, 0)`
        })
      const migratedNetwork = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [deployment] = yield* sql<{
          deployment: unknown
          network_id: string
        }>`SELECT network_id, deployment
            FROM kiln_tailscale_network_deployment`
        const [instance] = yield* sql<{ instance_id: string }>`
          SELECT instance_id FROM kiln_instance`
        const [network] = yield* sql<{ id: string }>`
          SELECT id FROM kiln_tailscale_network`
        const parsed =
          typeof deployment?.deployment === "string"
            ? JSON.parse(deployment.deployment)
            : deployment?.deployment
        return {
          deploymentId: parsed?.id,
          deploymentNetwork: deployment?.network_id,
          instance: instance?.instance_id,
          network: network?.id,
        }
      })

      it.effect(
        "keeps the network's ID everywhere",
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const { network } = yield* ids
            yield* dropAllTables
            yield* applyMigrations(
              migrations.filter((migration) => migration.id <= 57)
            )
            yield* sql`SET FOREIGN_KEY_CHECKS = 0`
            yield* insertRelay(fingerprint)
            yield* insertNetwork(legacyNetwork, legacyNetwork, fingerprint)
            yield* sql`SET FOREIGN_KEY_CHECKS = 1`

            yield* applyMigrations(migrations)

            expect(yield* migratedNetwork).toEqual({
              deploymentId: network,
              deploymentNetwork: network,
              instance: network,
              network,
            })
          }),
        schemaBuildTimeout
      )

      it.effect(
        "repairs what an earlier run gave the game server's ID",
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const { network, relay, server } = yield* ids
            yield* dropAllTables
            yield* applyMigrations(
              migrations.filter((migration) => migration.id <= 57)
            )
            yield* instanceIds.run
            // As that run left it: rows rewritten with the game server's ID,
            // and stopped re-adding the foreign key that broke.
            yield* sql`ALTER TABLE kiln_tailscale_network_deployment
              DROP FOREIGN KEY kiln_tailscale_network_deployment_network_fk`
            yield* sql`SET FOREIGN_KEY_CHECKS = 0`
            yield* insertRelay(relay)
            yield* sql`UPDATE kiln_relay SET fingerprint = ${fingerprint}`
            yield* insertNetwork(network, server, relay)
            yield* sql`INSERT INTO kiln_instance_id
                (id, kind, legacy_id, legacy_scope, relay_id, created_at)
              VALUES (${relay}, 'relay', ${fingerprint}, NULL, NULL, 0),
                     (${network}, 'tailscale', ${legacyNetwork}, NULL, NULL, 0),
                     (${server}, 'server', ${legacyNetwork}, ${fingerprint},
                      ${relay}, 0)`
            yield* sql`SET FOREIGN_KEY_CHECKS = 1`

            yield* instanceIds.run

            expect(yield* migratedNetwork).toEqual({
              deploymentId: network,
              deploymentNetwork: network,
              instance: network,
              network,
            })
            const [key] = yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count FROM information_schema.table_constraints
               WHERE table_schema = DATABASE()
                 AND constraint_name = 'kiln_tailscale_network_deployment_network_fk'`
            expect(Number(key?.count)).toBe(1)
          }),
        schemaBuildTimeout
      )
    })

    it.effect(
      "merges deployments and Kiln updates people already have",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 54)
          )
          const table = sql(databaseTableName("notification"))
          const app = {
            resource: {
              id: "app-a",
              name: "Site",
              relayId: "relay-a",
              type: "app",
            },
            update: true,
          }
          const row = (
            id: string,
            kind: string,
            data: object,
            createdAt: number,
            readAt: number | null
          ) => ({
            created_at: createdAt,
            data: JSON.stringify(data),
            id,
            kind,
            read_at: readAt,
            source_key: `${kind}:${id}`,
            user_id: "user-a",
          })
          yield* sql`INSERT INTO ${table} ${sql.insert([
            row("a", "app.deployed", { ...app, status: "failed" }, 1, null),
            row("b", "app.deployed", { ...app, status: "succeeded" }, 2, 5),
            row("c", "app.deployed", { ...app, status: "succeeded" }, 3, null),
            row("d", "app.deployed", { ...app, status: "succeeded" }, 4, 5),
            row(
              "e",
              "kiln.updated",
              { previousVersion: "1", version: "2" },
              1,
              5
            ),
            row(
              "f",
              "kiln.updated",
              { previousVersion: "2", version: "3" },
              2,
              null
            ),
            row(
              "g",
              "kiln.updated",
              { previousVersion: "3", version: "4" },
              3,
              null
            ),
          ])}`

          yield* applyMigrations(migrations)

          const rows = yield* sql<{
            data: unknown
            id: string
            readAt: number | null
          }>`
          SELECT id, data, read_at AS readAt FROM ${table}
           WHERE dismissed_at IS NULL ORDER BY id
        `
          const parsed = rows.map(({ data, id, readAt }) => ({
            data: typeof data === "string" ? JSON.parse(data) : data,
            id,
            read: readAt !== null,
          }))
          expect(parsed).toEqual([
            {
              data: { ...app, count: 3, failures: 1, status: "succeeded" },
              id: "d",
              read: false,
            },
            {
              data: { previousVersion: "2", version: "4" },
              id: "g",
              read: false,
            },
          ])
        }),
      schemaBuildTimeout
    )
  })
})
