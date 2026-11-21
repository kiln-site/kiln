import { describe, expect, layer } from "@effect/vitest"
import {
  migratedBackupDestinationId,
  migratedInstanceId,
  migratedTunnelId,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vite-plus/test"

import {
  decryptWithKeyring,
  encryptWithKeyring,
  parseSecretKeyring,
} from "../../keyring.mjs"

import { databaseTableName } from "@/lib/database-config"
import { migrations } from "@/migrations"
import { explicitBackupDestinations } from "@/migrations/0054_explicit_backup_destinations"
import { instanceIds } from "@/migrations/0058_instance_ids"
import { backupDestinationIds } from "@/migrations/0092_backup_destination_ids"
import { expandStoredSelections } from "@/lib/resource-permissions"
import { describeMysql, testDatabaseClient } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

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

          // Up to the schema it knew: a later one renames the copies' table.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id < 93)
          )
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
          // In the format destinations take now, which a later migration
          // moves an older ID to: this one is about who chose it.
          const storage = "d".repeat(12)
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

          // Up to the schema it knew: a later one renames the copies' table.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id < 93)
          )

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
        const state: Record<string, { definition: string; rows: unknown }> = {}
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
        // An expression default, as MySQL marks DEFAULT_GENERATED, keeps
        // the value it was given.
        yield* sql`CREATE TABLE kiln_dated (
          id int PRIMARY KEY,
          at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        )`
        yield* sql`INSERT INTO kiln_dated VALUES (1, '2020-01-02 03:04:05.000')`
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

    describe("a tailnet whose old ID is also a game server's", () => {
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

            // Up to networks becoming tailnets, which keep the ID it gives.
            yield* applyMigrations(
              migrations.filter((migration) => migration.id <= 78)
            )

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

    it.effect(
      "keeps what people could do to an App's files, as the file permissions every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while an App's files had permissions of
          // their own.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 60)
          )
          const relayId = "1".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "app.read",
              "app.files.read",
              "app.files.upload",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grants = {
            reader: ["app.files.read"],
            writer: ["app.files.write", "instance.files.write"],
            files: ["app.files.all"],
            apps: ["app.all"],
          }
          // Each a different person's grant on the Relay.
          for (const [id, keys] of Object.entries(grants)) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId: relayId,
              resourceType: "relay",
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          }
          // On one game server an App permission never did anything.
          yield* insertUser("server")
          yield* insertGrant({
            id: "server",
            relayId,
            resourceId: "5".repeat(12),
            resourceType: "instance",
            userId: "server",
          })
          yield* insertRows(
            "access_selection",
            selections({ access_id: "server" }, [
              "app.files.write",
              "instance.console.read",
            ])
          )
          yield* insertRows("permission_preset", {
            created_at: 1,
            id: "preset",
            name: "App files",
            relay_id: relayId,
            resource_id: relayId,
            resource_type: "relay",
            updated_at: 1,
          })
          yield* insertRows(
            "preset_selection",
            selections({ preset_id: "preset" }, ["app.files.read"])
          )

          yield* applyMigrations(migrations)

          const selected = (table: string, owner: string, id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\` FROM ${sql(databaseTableName(table))}
               WHERE ${sql(owner)} = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          const granted = (id: string) =>
            selected("access_selection", "access_id", id)
          expect(yield* granted("reader")).toEqual(["instance.files.read"])
          expect(yield* granted("writer")).toEqual([
            "instance.files.delete",
            "instance.files.write",
          ])
          expect(yield* granted("files")).toEqual([
            "instance.files.delete",
            "instance.files.write",
          ])
          // Selecting every App permission also covered an App's power,
          // deploying it, and its shell.
          expect(yield* granted("apps")).toEqual([
            "app.all",
            "instance.deploy",
            "instance.files.delete",
            "instance.files.write",
            "instance.limits.write",
            "instance.network.write",
            "instance.power.kill",
            "instance.terminal",
          ])
          expect(yield* granted("server")).toEqual(["instance.console.read"])
          expect(
            yield* selected("preset_selection", "preset_id", "preset")
          ).toEqual(["instance.files.read"])

          // What was stored now loads, and reaches an App's files and the
          // App itself.
          const apps = expandStoredSelections(
            (yield* granted("apps")).map((key) => ({
              key,
              kind: key.endsWith(".all") ? "collection" : "permission",
            })),
            "relay"
          )
          expect(apps).toEqual(
            expect.arrayContaining([
              "app.manage",
              "app.read",
              "instance.files.read",
              "instance.files.write",
              "instance.files.delete",
            ])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual([
            "app.read",
            "instance.files.list",
            "instance.files.read",
            "instance.files.upload",
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could power a database or an App, as the power permissions every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while a database's power had a permission
          // of its own and an App's went with configuring it.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 61)
          )
          const relayId = "1".repeat(12)
          const databaseId = "2".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "database.read",
              "database.power",
              "app.manage",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "database" | "instance" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          })
          yield* grant("databases", "relay", relayId, [
            "database.power",
            "database.logs.read",
          ])
          yield* grant("block", "relay", relayId, ["database.power.all"])
          yield* grant("apps", "relay", relayId, ["app.manage"])
          yield* grant("observer", "relay", relayId, ["app.logs.read"])
          yield* grant("database", "database", databaseId, ["database.power"])
          // On one game server a database permission never did anything.
          yield* grant("server", "instance", "5".repeat(12), [
            "database.power",
            "database.power.all",
            "instance.console.read",
          ])
          yield* insertRows("permission_preset", {
            created_at: 1,
            id: "preset",
            name: "Database power",
            relay_id: relayId,
            resource_id: databaseId,
            resource_type: "database",
            updated_at: 1,
          })
          yield* insertRows(
            "preset_selection",
            selections({ preset_id: "preset" }, ["database.power"])
          )

          yield* applyMigrations(migrations)

          const selected = (table: string, owner: string, id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\` FROM ${sql(databaseTableName(table))}
               WHERE ${sql(owner)} = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          const granted = (id: string) =>
            selected("access_selection", "access_id", id)
          expect(yield* granted("databases")).toEqual([
            "instance.logs.read",
            "instance.power.kill",
          ])
          expect(yield* granted("block")).toEqual(["instance.power.kill"])
          expect(yield* granted("apps")).toEqual([
            "app.manage",
            "instance.deploy",
            "instance.limits.write",
            "instance.network.write",
            "instance.power.kill",
          ])
          expect(yield* granted("observer")).toEqual(["instance.logs.read"])
          expect(yield* granted("database")).toEqual(["instance.power.kill"])
          expect(yield* granted("server")).toEqual(["instance.console.read"])
          expect(
            yield* selected("preset_selection", "preset_id", "preset")
          ).toEqual(["instance.power.kill"])

          // What was stored now loads, and still starts and stops.
          const loaded = (
            keys: ReadonlyArray<string>,
            scope: "database" | "relay"
          ) =>
            expandStoredSelections(
              keys.map((key) => ({
                key,
                kind: key.endsWith(".all") ? "collection" : "permission",
              })),
              scope
            )
          expect(loaded(yield* granted("database"), "database")).toEqual(
            expect.arrayContaining([
              "database.read",
              "instance.power.start",
              "instance.power.stop",
              "instance.power.restart",
              "instance.power.kill",
            ])
          )
          expect(loaded(yield* granted("apps"), "relay")).toEqual(
            expect.arrayContaining([
              "app.manage",
              "app.read",
              "instance.power.start",
              "instance.power.kill",
            ])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual([
            "database.read",
            "instance.power.start",
            "instance.power.stop",
            "instance.power.restart",
            "instance.power.kill",
            "app.manage",
            "instance.network.write",
            "instance.limits.write",
            "instance.deploy",
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could deploy an App, reinstall a game server or replace a database's container, as the deploy permission every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while deploying an App went with
          // configuring it, and reinstalling a game server with changing
          // its configuration.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 62)
          )
          const relayId = "1".repeat(12)
          const databaseId = "2".repeat(12)
          const serverId = "5".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "database.read",
              "instance.create",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "database" | "instance" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          })
          yield* grant("apps", "relay", relayId, ["app.manage"])
          yield* grant("everyApp", "relay", relayId, ["app.all"])
          yield* grant("server", "instance", serverId, [
            "instance.configuration.write",
          ])
          yield* grant("limits", "database", databaseId, [
            "database.limits.write",
          ])
          yield* grant("observer", "relay", relayId, [
            "app.logs.read",
            "instance.configuration.read",
          ])
          // On one database a game server's configuration never did
          // anything.
          yield* grant("stray", "database", databaseId, [
            "instance.configuration.write",
            "database.logs.read",
          ])
          yield* insertRows("permission_preset", {
            created_at: 1,
            id: "preset",
            name: "Server configuration",
            relay_id: relayId,
            resource_id: serverId,
            resource_type: "instance",
            updated_at: 1,
          })
          yield* insertRows(
            "preset_selection",
            selections({ preset_id: "preset" }, ["instance.configuration.all"])
          )

          yield* applyMigrations(migrations)

          const selected = (table: string, owner: string, id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\` FROM ${sql(databaseTableName(table))}
               WHERE ${sql(owner)} = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          const granted = (id: string) =>
            selected("access_selection", "access_id", id)
          expect(yield* granted("apps")).toEqual([
            "app.manage",
            "instance.deploy",
            "instance.limits.write",
            "instance.network.write",
          ])
          expect(yield* granted("everyApp")).toEqual([
            "app.all",
            "instance.deploy",
            "instance.limits.write",
            "instance.network.write",
            "instance.terminal",
          ])
          expect(yield* granted("server")).toEqual([
            "instance.configuration.write",
            "instance.deploy",
          ])
          // Its limits permission has since become every instance's.
          expect(yield* granted("limits")).toEqual([
            "instance.deploy",
            "instance.limits.write",
          ])
          expect(yield* granted("observer")).toEqual([
            "instance.configuration.read",
            "instance.logs.read",
          ])
          expect(yield* granted("stray")).toEqual([
            "instance.configuration.write",
            "instance.logs.read",
          ])
          expect(
            yield* selected("preset_selection", "preset_id", "preset")
          ).toEqual([
            "instance.configuration.all",
            "instance.deploy",
            "instance.limits.write",
          ])

          // What was stored now loads, and deploys what it could before.
          const loaded = (
            keys: ReadonlyArray<string>,
            scope: "database" | "instance" | "relay"
          ) =>
            expandStoredSelections(
              keys.map((key) => ({
                key,
                kind: key.endsWith(".all") ? "collection" : "permission",
              })),
              scope
            )
          expect(loaded(yield* granted("limits"), "database")).toEqual(
            expect.arrayContaining(["database.read", "instance.deploy"])
          )
          expect(loaded(yield* granted("server"), "instance")).toEqual(
            expect.arrayContaining(["instance.read", "instance.deploy"])
          )
          expect(loaded(yield* granted("apps"), "relay")).toEqual(
            expect.arrayContaining([
              "app.manage",
              "app.read",
              "instance.deploy",
            ])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual([
            "database.read",
            "instance.create",
            "instance.limits.write",
            "instance.deploy",
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps what each App decided about its updates when they become every instance's",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while only image Apps took updates.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 66)
          )
          const relayId = "1".repeat(12)
          const appId = "a".repeat(12)
          const digest = `sha256:${"2".repeat(64)}`
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("app", {
            app_id: appId,
            config_ciphertext: "ciphertext",
            created_at: 1,
            created_by: "owner",
            name: "Website",
            owner_id: "owner",
            relay_id: relayId,
            updated_at: 1,
          })
          yield* insertRows("app_image_update", {
            app_id: appId,
            delay_hours: 24,
            image: "ghcr.io/kiln-site/marketing:latest",
            latest_digest: digest,
            latest_seen_at: 5,
            mode: "auto",
            skipped_digest: digest,
            state: "available",
            updated_at: 1,
          })
          yield* insertRows("app_image_update_attempt", {
            app_id: appId,
            attempted_at: 7,
            deployment_id: "d".repeat(36),
            digest,
          })

          yield* applyMigrations(migrations)

          const updates = yield* sql<Record<string, unknown>>`
            SELECT instance_id, instance_kind, mode, delay_hours, state,
                   latest_digest, skipped_digest
              FROM ${sql(databaseTableName("instance_update"))}
          `
          expect(
            updates.map((row) => ({
              ...row,
              delay_hours: Number(row.delay_hours),
            }))
          ).toEqual([
            {
              delay_hours: 24,
              instance_id: appId,
              instance_kind: "app",
              latest_digest: digest,
              mode: "auto",
              skipped_digest: digest,
              state: "available",
            },
          ])
          const attempts = yield* sql<Record<string, unknown>>`
            SELECT instance_id, digest, deployment_id
              FROM ${sql(databaseTableName("instance_update_attempt"))}
          `
          expect(attempts).toEqual([
            { deployment_id: "d".repeat(36), digest, instance_id: appId },
          ])
          // Its rows are its own now: gone when it is deleted, not with the
          // App table's row.
          yield* sql`DELETE FROM ${sql(databaseTableName("app"))}`
          const kept = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count
              FROM ${sql(databaseTableName("instance_update"))}
          `
          expect(Number(kept[0]?.count)).toBe(1)
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps an update's notification when it takes every instance's name",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while the notification was an App's by name.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 68)
          )
          const appId = "a".repeat(12)
          const digest = `sha256:${"2".repeat(64)}`
          yield* insertUser("owner")
          yield* insertRows("notification", {
            created_at: 1,
            data: JSON.stringify({
              digest,
              image: "ghcr.io/kiln-site/marketing:latest",
              kind: "app.image-update",
              resource: {
                id: appId,
                name: "Website",
                relayId: "1".repeat(12),
                type: "app",
              },
            }),
            id: "11111111-1111-4111-8111-111111111111",
            kind: "app.image-update",
            source_key: `app.image-update:${appId}:${digest}`,
            user_id: "owner",
          })

          yield* applyMigrations(migrations)

          const rows = yield* sql<{
            contentKind: string
            image: string
            kind: string
            sourceKey: string
          }>`
            SELECT kind, source_key AS sourceKey,
                   JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) AS contentKind,
                   JSON_UNQUOTE(JSON_EXTRACT(data, '$.image')) AS image
              FROM ${sql(databaseTableName("notification"))}
          `
          expect(rows).toEqual([
            {
              contentKind: "instance.image-update",
              image: "ghcr.io/kiln-site/marketing:latest",
              kind: "instance.image-update",
              sourceKey: `instance.image-update:${appId}:${digest}`,
            },
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "gives a database made before databases ran Bricks its engine's Brick, image and port",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while a database's image and port followed
          // from its engine.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 65)
          )
          const relayId = "1".repeat(12)
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          const database = (id: string, engine: string) => ({
            created_at: 1,
            created_by: "owner",
            database_id: id.repeat(12),
            database_name: `db_${engine}`,
            engine,
            name: engine,
            owner_id: "owner",
            password_ciphertext: "ciphertext",
            relay_id: relayId,
            updated_at: 1,
            username: `user_${engine}`,
          })
          yield* insertRows("database", database("a", "postgres"))
          yield* insertRows("database", database("b", "mariadb"))
          yield* insertRows("database", database("c", "valkey"))

          yield* applyMigrations(migrations)

          const rows = yield* sql<{
            brick: string
            engine: string
            image: string
            port: number
            source: string | null
          }>`
            SELECT engine, brick_id AS brick, brick_source AS source, image,
                   internal_port AS port
              FROM ${sql(databaseTableName("database"))} ORDER BY engine
          `
          expect(
            rows.map((row) => ({ ...row, port: Number(row.port) }))
          ).toEqual([
            {
              brick: "mariadb",
              engine: "mariadb",
              image: "mariadb:11.8",
              port: 3306,
              source: null,
            },
            {
              brick: "postgres",
              engine: "postgres",
              image: "postgres:17",
              port: 5432,
              source: null,
            },
            {
              brick: "valkey",
              engine: "valkey",
              image: "valkey/valkey:8",
              port: 6379,
              source: null,
            },
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could change a database's or an App's limits, as the limits permission every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while a database's limits had a permission
          // of their own and an App's went with configuring it.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 64)
          )
          const relayId = "1".repeat(12)
          const databaseId = "2".repeat(12)
          const serverId = "5".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "database.read",
              "database.create",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "database" | "instance" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          })
          yield* grant("database", "database", databaseId, [
            "database.limits.write",
          ])
          yield* grant("block", "relay", relayId, ["database.limits.all"])
          yield* grant("apps", "relay", relayId, ["app.manage"])
          // A game server's limits came with reading its configuration,
          // and with selecting all of it.
          yield* grant("server", "instance", serverId, [
            "instance.limits.write",
          ])
          yield* grant("configuration", "instance", serverId, [
            "instance.configuration.all",
          ])
          yield* grant("observer", "relay", relayId, ["database.logs.read"])

          yield* applyMigrations(migrations)

          const granted = (id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\`
                FROM ${sql(databaseTableName("access_selection"))}
               WHERE access_id = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          expect(yield* granted("database")).toEqual(["instance.limits.write"])
          expect(yield* granted("block")).toEqual(["instance.limits.write"])
          expect(yield* granted("apps")).toEqual([
            "app.manage",
            "instance.limits.write",
            "instance.network.write",
          ])
          expect(yield* granted("server")).toEqual([
            "instance.configuration.read",
            "instance.limits.write",
          ])
          expect(yield* granted("configuration")).toEqual([
            "instance.configuration.all",
            "instance.limits.write",
          ])
          expect(yield* granted("observer")).toEqual(["instance.logs.read"])

          // What was stored now loads, and changes the limits it could.
          const loaded = (
            keys: ReadonlyArray<string>,
            scope: "database" | "instance" | "relay"
          ) =>
            expandStoredSelections(
              keys.map((key) => ({
                key,
                kind: key.endsWith(".all") ? "collection" : "permission",
              })),
              scope
            )
          expect(loaded(yield* granted("database"), "database")).toEqual(
            expect.arrayContaining(["database.read", "instance.limits.write"])
          )
          expect(loaded(yield* granted("server"), "instance")).toEqual(
            expect.arrayContaining([
              "instance.configuration.read",
              "instance.limits.write",
            ])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual([
            "database.read",
            "database.create",
            "instance.limits.write",
          ])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could save an App's web routes, as the network permission every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while saving an App's web routes went with
          // configuring it.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 72)
          )
          const relayId = "1".repeat(12)
          const serverId = "5".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify(["app.read", "app.manage"]),
            client_role: "custom",
          })
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "instance" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              keys.map((key) => ({
                access_id: id,
                selection_kind: key.endsWith(".all")
                  ? "collection"
                  : "permission",
                selection_key: key,
              }))
            )
          })
          yield* grant("configures", "relay", relayId, ["app.manage"])
          yield* grant("everything", "relay", relayId, ["app.all"])
          // Seeing Apps never saved their routes, and a game server's
          // network already took this.
          yield* grant("viewer", "relay", relayId, ["app.read"])
          yield* grant("server", "instance", serverId, [
            "instance.network.read",
          ])

          yield* applyMigrations(migrations)

          const granted = (id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\`
                FROM ${sql(databaseTableName("access_selection"))}
               WHERE access_id = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          expect(yield* granted("configures")).toEqual([
            "app.manage",
            "instance.network.write",
          ])
          expect(yield* granted("everything")).toEqual([
            "app.all",
            "instance.network.write",
            "instance.terminal",
          ])
          expect(yield* granted("viewer")).toEqual(["app.read"])
          expect(yield* granted("server")).toEqual(["instance.network.read"])

          // What was stored now loads, and saves the routes it could.
          expect(
            expandStoredSelections(
              (yield* granted("configures")).map((key) => ({
                key,
                kind: "permission" as const,
              })),
              "relay"
            )
          ).toEqual(
            expect.arrayContaining(["app.manage", "instance.network.write"])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual(["app.read", "app.manage", "instance.network.write"])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could open an App's or a database's shell, as the terminal permission every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while each kind's shell had a permission of
          // its own.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 75)
          )
          const relayId = "1".repeat(12)
          const databaseId = "6".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "app.read",
              "app.terminal",
              "database.dump.import",
            ]),
            client_role: "custom",
          })
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "database" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              keys.map((key) => ({
                access_id: id,
                selection_kind: key.endsWith(".all")
                  ? "collection"
                  : "permission",
                selection_key: key,
              }))
            )
          })
          yield* grant("app-shell", "relay", relayId, ["app.terminal"])
          yield* grant("every-app", "relay", relayId, ["app.all"])
          yield* grant("database-shell", "database", databaseId, [
            "database.read",
            "database.terminal",
          ])
          yield* grant("database-shells", "relay", relayId, [
            "database.terminal.all",
          ])
          yield* grant("viewer", "relay", relayId, ["app.read"])

          yield* applyMigrations(migrations)

          const granted = (id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\`
                FROM ${sql(databaseTableName("access_selection"))}
               WHERE access_id = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          expect(yield* granted("app-shell")).toEqual(["instance.terminal"])
          expect(yield* granted("every-app")).toEqual([
            "app.all",
            "instance.terminal",
          ])
          expect(yield* granted("database-shell")).toEqual([
            "database.read",
            "instance.terminal",
          ])
          expect(yield* granted("database-shells")).toEqual([
            "instance.terminal",
          ])
          expect(yield* granted("viewer")).toEqual(["app.read"])

          // What was stored now loads, and opens the shell it could.
          expect(
            expandStoredSelections(
              [{ key: "app.all", kind: "collection" }],
              "relay"
            )
          ).not.toContain("instance.terminal")
          expect(
            expandStoredSelections(
              (yield* granted("database-shell")).map((key) => ({
                key,
                kind: "permission" as const,
              })),
              "database"
            )
          ).toContain("instance.terminal")

          // A database's shell took importing a dump on the Relay, which
          // stays for that and isn't widened to every shell there.
          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual(["app.read", "instance.terminal", "database.dump.import"])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps who could read an App's or a database's logs, as the logs permission every instance takes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while each kind's logs had a permission of
          // its own.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 76)
          )
          const relayId = "1".repeat(12)
          const databaseId = "6".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "app.read",
              "app.logs.read",
              "database.logs.read",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grant = Effect.fnUntraced(function* (
            id: string,
            resourceType: "database" | "relay",
            resourceId: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId,
              resourceType,
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          })
          yield* grant("app-logs", "relay", relayId, ["app.logs.read"])
          yield* grant("app-log-blocks", "relay", relayId, ["app.logs.all"])
          yield* grant("database-logs", "database", databaseId, [
            "database.read",
            "database.logs.read",
          ])
          yield* grant("database-log-blocks", "relay", relayId, [
            "database.logs.all",
          ])
          yield* grant("every-database", "database", databaseId, [
            "database.all",
          ])
          yield* insertRows("permission_preset", {
            created_at: 1,
            id: "preset",
            name: "Log readers",
            relay_id: relayId,
            resource_id: relayId,
            resource_type: "relay",
            updated_at: 1,
          })
          yield* insertRows(
            "preset_selection",
            selections({ preset_id: "preset" }, [
              "app.logs.read",
              "database.logs.read",
            ])
          )

          yield* applyMigrations(migrations)

          const selected = (table: string, owner: string, id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\` FROM ${sql(databaseTableName(table))}
               WHERE ${sql(owner)} = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          const granted = (id: string) =>
            selected("access_selection", "access_id", id)
          expect(yield* granted("app-logs")).toEqual(["instance.logs.read"])
          expect(yield* granted("app-log-blocks")).toEqual([
            "instance.logs.read",
          ])
          expect(yield* granted("database-logs")).toEqual([
            "database.read",
            "instance.logs.read",
          ])
          expect(yield* granted("database-log-blocks")).toEqual([
            "instance.logs.read",
          ])
          expect(yield* granted("every-database")).toEqual(["database.all"])
          expect(
            yield* selected("preset_selection", "preset_id", "preset")
          ).toEqual(["instance.logs.read"])

          // What was stored now loads, and reads the logs it could.
          expect(
            expandStoredSelections(
              (yield* granted("database-logs")).map((key) => ({
                key,
                kind: "permission" as const,
              })),
              "database"
            )
          ).toContain("instance.logs.read")
          expect(
            expandStoredSelections(
              [{ key: "database.all", kind: "collection" }],
              "database"
            )
          ).toContain("instance.logs.read")
          expect(
            expandStoredSelections(
              [{ key: "app.all", kind: "collection" }],
              "relay"
            )
          ).toContain("instance.logs.read")

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual(["app.read", "instance.logs.read"])
        }),
      schemaBuildTimeout
    )

    // Kiln knows the Cloudflare records it made by their row's ID, so a
    // row that changes ID, or is lost, leaves records nothing deletes.
    it.effect(
      "keeps every address and web hostname, with its ID and record, as one table",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while a game server's addresses and web
          // hostnames were two tables.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 74)
          )
          const relayId = "1".repeat(12)
          const serverId = "5".repeat(12)
          const appId = "a".repeat(12)
          yield* insertRows("domain_integration", {
            api_token_ciphertext: "token",
            blacklist_patterns: "[]",
            created_at: 1,
            id: "cloudflare",
            name: "Cloudflare",
            owner_id: null,
            provider: "cloudflare",
            updated_at: 1,
            zones: "[]",
          })
          yield* insertRows("domain_zone", {
            created_at: 1,
            domain: "kiln.test",
            enabled: 1,
            integration_id: "cloudflare",
            is_default: 1,
            updated_at: 1,
            zone_id: "z".repeat(32),
            zone_name: "kiln.test",
          })
          const address = (
            id: string,
            label: string,
            row: Record<string, unknown> = {}
          ) => ({
            address_record_id: `${id}-a`.padEnd(32, "0"),
            address_record_type: "A",
            created_at: 1,
            domain: "kiln.test",
            id: id.padEnd(36, "0"),
            instance_id: serverId,
            integration_id: "cloudflare",
            is_primary: 0,
            next_domain: null,
            next_vanity_label: null,
            srv_protocol: null,
            srv_record_id: null,
            srv_service: null,
            supports_srv: 0,
            public_host: "203.0.113.10",
            public_port: 25565,
            relay_id: relayId,
            status: "active",
            updated_at: 1,
            vanity_label: label,
            ...row,
          })
          yield* insertRows("instance_domain", [
            // Players join by name, and a rename is under way.
            address("primary", "deep-moon", {
              is_primary: 1,
              next_domain: "kiln.test",
              next_vanity_label: "new-moon",
              srv_protocol: "tcp",
              srv_record_id: "s".repeat(32),
              srv_service: "minecraft",
              supports_srv: 1,
            }),
            // Its web routes answer on these two as well.
            address("shared", "shared"),
            address("leaving", "leaving", { status: "removing" }),
          ])
          const hostname = (
            id: string,
            name: string,
            row: Record<string, unknown> = {}
          ) => ({
            created_at: 1,
            hostname: name,
            id: id.padEnd(36, "0"),
            integration_id: "cloudflare",
            is_generated: 0,
            proxied: 0,
            record_id: null,
            record_type: null,
            relay_id: relayId,
            resource_id: serverId,
            resource_type: "instance",
            routed: 1,
            target: null,
            status: "active",
            updated_at: 1,
            vanity_domain: "kiln.test",
            zone_id: "z".repeat(32),
            ...row,
          })
          yield* insertRows("web_hostname", [
            hostname("route-shared", "shared.kiln.test"),
            hostname("route-leaving", "leaving.kiln.test", {
              record_id: "w".repeat(32),
              record_type: "CNAME",
              status: "pending",
            }),
            hostname("route-own", "wiki.example.test", {
              proxied: 1,
              record_id: "o".repeat(32),
              record_type: "CNAME",
              target: "relay.example.test",
              vanity_domain: null,
            }),
            hostname("app", "quiet-lake.kiln.test", {
              is_generated: 1,
              record_id: "g".repeat(32),
              record_type: "CNAME",
              resource_id: appId,
              resource_type: "app",
              routed: 0,
            }),
          ])

          yield* applyMigrations(migrations)

          const rows = yield* sql<Record<string, unknown>>`
            SELECT id, hostname, resource_type, resource_id, zone_id,
                   vanity_domain, game, routed, is_generated,
                   next_hostname, next_vanity_domain, public_port,
                   supports_srv, srv_record_id, record_id, record_type,
                   target, proxied, status
              FROM ${sql(databaseTableName("instance_address"))}
             ORDER BY hostname
          `
          const kept = Object.fromEntries(
            rows.map((row) => [String(row.hostname), row])
          )
          expect(Object.keys(kept)).toEqual([
            "deep-moon.kiln.test",
            "leaving.kiln.test",
            "quiet-lake.kiln.test",
            "shared.kiln.test",
            "wiki.example.test",
          ])
          // A game server's address, its label still read from its name.
          expect(kept["deep-moon.kiln.test"]).toMatchObject({
            game: 1,
            id: "primary".padEnd(36, "0"),
            next_hostname: "new-moon.kiln.test",
            next_vanity_domain: "kiln.test",
            public_port: 25565,
            record_id: "primary-a".padEnd(32, "0"),
            record_type: "A",
            resource_id: serverId,
            resource_type: "instance",
            routed: 0,
            srv_record_id: "s".repeat(32),
            supports_srv: 1,
            target: "203.0.113.10",
            vanity_domain: "kiln.test",
            zone_id: "z".repeat(32),
          })
          // Its route on its own address: one row, the address's.
          expect(kept["shared.kiln.test"]).toMatchObject({
            game: 1,
            id: "shared".padEnd(36, "0"),
            record_id: "shared-a".padEnd(32, "0"),
            routed: 1,
          })
          // An address on its way out leaves the name to its route.
          expect(kept["leaving.kiln.test"]).toMatchObject({
            game: 0,
            id: "route-leaving".padEnd(36, "0"),
            record_id: "w".repeat(32),
            routed: 1,
            status: "pending",
          })
          expect(kept["wiki.example.test"]).toMatchObject({
            game: 0,
            id: "route-own".padEnd(36, "0"),
            proxied: 1,
            record_id: "o".repeat(32),
            target: "relay.example.test",
            vanity_domain: null,
          })
          expect(kept["quiet-lake.kiln.test"]).toMatchObject({
            game: 0,
            id: "app".padEnd(36, "0"),
            is_generated: 1,
            record_id: "g".repeat(32),
            resource_id: appId,
            resource_type: "app",
          })
          // The address players join by stays the game server's primary,
          // named by the one row that says which it is.
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT instance_type, instance_id, address_kind, address_ref
                FROM ${sql(databaseTableName("instance_primary_address"))}
            `
          ).toEqual([
            {
              address_kind: "join",
              address_ref: "primary".padEnd(36, "0"),
              instance_id: serverId,
              instance_type: "instance",
            },
          ])
          const old = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name IN (${databaseTableName("instance_domain")},
                                  ${databaseTableName("web_hostname")})
          `
          expect(old).toEqual([])
        }),
      schemaBuildTimeout
    )

    // Each tailnet's node on a Relay becomes a tunnel with an ID
    // of its own, which the Relay works out the same way, and the network a
    // tailnet: the group of its tunnels, with what they share beside it.
    it.effect(
      "turns each network into a tailnet and each of its nodes into a tunnel",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 78)
          )
          const networkId = "a".repeat(12)
          const relayId = "1".repeat(12)
          yield* insertRows("instance_id", {
            created_at: 1,
            id: networkId,
            kind: "tailscale",
          })
          yield* insertRows("tailscale_network", {
            created_at: 5,
            domain: "kiln",
            id: networkId,
            name: "Home",
            owner_id: "owner",
            updated_at: 6,
          })
          yield* insertRows("tailscale_network_deployment", {
            cleanup_next_attempt_at: 0,
            deployment: JSON.stringify({
              bindings: [],
              id: networkId,
              instance: { id: networkId, observedState: "running" },
              relayId,
              relayName: "Relay One",
            }),
            network_id: networkId,
            observed_at: 0,
            relay_id: relayId,
            updated_at: 0,
          })

          // Up to names moving to Hearth, which take the network's domain.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 80)
          )

          const tunnelId = yield* Effect.promise(() =>
            migratedTunnelId(networkId, relayId)
          )
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, kind FROM ${sql(databaseTableName("instance_id"))}
               ORDER BY kind
            `
          ).toEqual([
            { id: networkId, kind: "group" },
            { id: tunnelId, kind: "tunnel" },
          ])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, name, created_by
                FROM ${sql(databaseTableName("instance_group"))}
            `
          ).toEqual([{ created_by: "owner", id: networkId, name: "Home" }])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, domain, owner_id
                FROM ${sql(databaseTableName("tailnet"))}
            `
          ).toEqual([{ domain: "kiln", id: networkId, owner_id: "owner" }])
          const [tunnel] = yield* sql<{
            id: string
            owner_id: string
            relay_id: string
            state: unknown
            tailnet_id: string
          }>`
            SELECT id, tailnet_id, relay_id, owner_id, state
              FROM ${sql(databaseTableName("tunnel"))}
          `
          expect(tunnel).toMatchObject({
            id: tunnelId,
            owner_id: "owner",
            relay_id: relayId,
            tailnet_id: networkId,
          })
          const state =
            typeof tunnel?.state === "string"
              ? JSON.parse(tunnel.state)
              : tunnel?.state
          expect(state).toMatchObject({
            id: tunnelId,
            observedState: "running",
            relayName: "Relay One",
            tailnetId: networkId,
          })
          expect(state).not.toHaveProperty("instance")
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT instance_id, group_id, instance_kind, relay_id
                FROM ${sql(databaseTableName("instance_group_member"))}
            `
          ).toEqual([
            {
              group_id: networkId,
              instance_id: tunnelId,
              instance_kind: "tunnel",
              relay_id: relayId,
            },
          ])
          const old = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name IN (${databaseTableName("tailscale_network")},
                                  ${databaseTableName("tailscale_network_deployment")})
          `
          expect(old).toEqual([])
        }),
      schemaBuildTimeout
    )

    // Hearth keeps every name: a tailnet's domain is its first TLD, and the
    // hostname each member had on its tunnel is its generated name.
    it.effect(
      "moves a tailnet's domain and its members' hostnames to Hearth's names",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 80)
          )
          const tailnetId = "a".repeat(12)
          const tunnelId = "b".repeat(12)
          const memberId = `instance:${"c".repeat(12)}`
          yield* insertRows("instance_group", {
            created_at: 1,
            created_by: "owner",
            id: tailnetId,
            name: "Home",
            updated_at: 1,
          })
          yield* insertRows("tailnet", {
            created_at: 1,
            domain: "kiln",
            id: tailnetId,
            updated_at: 1,
          })
          yield* insertRows("tunnel", {
            cleanup_next_attempt_at: 0,
            id: tunnelId,
            observed_at: 0,
            relay_id: "1".repeat(12),
            state: JSON.stringify({
              bindings: [
                {
                  address: "10.165.55.10",
                  enabled: true,
                  hostname: "survival",
                  memberId,
                },
              ],
              domain: "kiln",
              id: tunnelId,
              tailnetId,
            }),
            tailnet_id: tailnetId,
            updated_at: 0,
          })

          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 81)
          )

          expect(
            yield* sql<Record<string, unknown>>`
              SELECT tailnet_id, domain, position
                FROM ${sql(databaseTableName("tailnet_domain"))}
            `
          ).toEqual([{ domain: "kiln", position: 0, tailnet_id: tailnetId }])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT member_id, label, domain, generated_for
                FROM ${sql(databaseTableName("tunnel_name"))}
            `
          ).toEqual([
            {
              domain: "kiln",
              generated_for: memberId,
              label: "survival",
              member_id: memberId,
            },
          ])
          const [tunnel] = yield* sql<{ state: unknown }>`
            SELECT state FROM ${sql(databaseTableName("tunnel"))}
          `
          const state =
            typeof tunnel?.state === "string"
              ? JSON.parse(tunnel.state)
              : tunnel?.state
          expect(state).toMatchObject({
            bindings: [{ address: "10.165.55.10", enabled: true, memberId }],
            domains: ["kiln"],
          })
          expect(state).not.toHaveProperty("domain")
          expect(state.bindings[0]).not.toHaveProperty("hostname")
        }),
      schemaBuildTimeout
    )

    // A tunnel runs a Brick. One made before then runs Kiln's `tailscale`
    // Brick at the images it already ran, with no source, as its Relay
    // records it; one that names its Brick keeps it.
    it.effect(
      "gives each tunnel from before Bricks the Brick it runs",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 82)
          )
          const tailnetId = "a".repeat(12)
          yield* insertRows("instance_group", {
            created_at: 1,
            created_by: "owner",
            id: tailnetId,
            name: "Home",
            updated_at: 1,
          })
          yield* insertRows("tailnet", {
            created_at: 1,
            id: tailnetId,
            updated_at: 1,
          })
          const named = {
            id: "tailscale",
            images: {
              dns: "coredns/coredns:1.15.0",
              tailscale: "tailscale/tailscale:v1.90.0",
            },
            revision: 2,
            source: "https://bricks.example/bricks/tailscale.yml",
          }
          for (const [id, brick] of [
            ["b".repeat(12), undefined],
            ["c".repeat(12), named],
          ] as const) {
            yield* insertRows("tunnel", {
              cleanup_next_attempt_at: 0,
              id,
              observed_at: 0,
              relay_id: id === "b".repeat(12) ? "1".repeat(12) : "2".repeat(12),
              state: JSON.stringify({
                bindings: [],
                domains: ["kiln"],
                id,
                tailnetId,
                ...(brick ? { brick } : {}),
              }),
              tailnet_id: tailnetId,
              updated_at: 0,
            })
          }

          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 83)
          )

          const rows = yield* sql<{ id: string; state: unknown }>`
            SELECT id, state FROM ${sql(databaseTableName("tunnel"))}
             ORDER BY id
          `
          const bricks = rows.map(
            (row) =>
              (typeof row.state === "string"
                ? JSON.parse(row.state)
                : row.state
              ).brick
          )
          expect(bricks).toEqual([
            {
              id: "tailscale",
              images: {
                dns: "coredns/coredns:1.14.7",
                tailscale: "tailscale/tailscale:stable",
              },
              revision: 1,
              source: null,
            },
            named,
          ])
        }),
      schemaBuildTimeout
    )

    // A tailnet becomes a tunnel, one instance, and its Relays its gateways:
    // each table is renamed for what it keeps, the tunnel takes its name
    // from its group, which goes, and the directory and deployments name
    // each as what it is now.
    it.effect(
      "makes each tailnet a tunnel and each of its tunnels a gateway",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 83)
          )
          const tailnetId = "a".repeat(12)
          const gatewayId = "b".repeat(12)
          const relayId = "1".repeat(12)
          const source = "https://bricks.example/bricks/tailscale.yml"
          yield* insertRows("instance_id", [
            { created_at: 1, id: tailnetId, kind: "group" },
            { created_at: 1, id: gatewayId, kind: "tunnel", relay_id: relayId },
          ])
          yield* insertRows("instance_group", {
            created_at: 1,
            created_by: "owner",
            id: tailnetId,
            name: "Home",
            updated_at: 1,
          })
          yield* insertRows("tailnet", {
            created_at: 1,
            id: tailnetId,
            owner_id: "owner",
            updated_at: 1,
          })
          yield* insertRows("tailnet_domain", {
            domain: "kiln",
            position: 0,
            tailnet_id: tailnetId,
          })
          yield* insertRows("tunnel", {
            cleanup_next_attempt_at: 0,
            id: gatewayId,
            observed_at: 0,
            owner_id: "owner",
            relay_id: relayId,
            state: JSON.stringify({
              bindings: [],
              brick: { id: "tailscale", revision: 1, source },
              domains: ["kiln"],
              id: gatewayId,
              tailnetId,
            }),
            tailnet_id: tailnetId,
            updated_at: 0,
          })
          yield* insertRows("instance_group_member", {
            created_at: 1,
            group_id: tailnetId,
            instance_id: gatewayId,
            instance_kind: "tunnel",
            relay_id: relayId,
          })

          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 84)
          )

          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, name, owner_id, brick_source
                FROM ${sql(databaseTableName("tunnel"))}
            `
          ).toEqual([
            {
              brick_source: source,
              id: tailnetId,
              name: "Home",
              owner_id: "owner",
            },
          ])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, tunnel_id, relay_id
                FROM ${sql(databaseTableName("tunnel_gateway"))}
            `
          ).toEqual([
            { id: gatewayId, relay_id: relayId, tunnel_id: tailnetId },
          ])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT tunnel_id, domain
                FROM ${sql(databaseTableName("tunnel_domain"))}
            `
          ).toEqual([{ domain: "kiln", tunnel_id: tailnetId }])
          expect(
            yield* sql<Record<string, unknown>>`
              SELECT id, kind FROM ${sql(databaseTableName("instance_id"))}
               ORDER BY id
            `
          ).toEqual([
            { id: tailnetId, kind: "tunnel" },
            { id: gatewayId, kind: "gateway" },
          ])
          expect(
            yield* sql`SELECT id FROM ${sql(databaseTableName("instance_group"))}`
          ).toEqual([])
          expect(
            yield* sql`SELECT instance_id FROM ${sql(databaseTableName("instance_group_member"))}`
          ).toEqual([])
          const old = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name IN (${databaseTableName("tailnet")},
                                  ${databaseTableName("tailnet_domain")})
          `
          expect(old).toEqual([])
        }),
      schemaBuildTimeout
    )
    it.effect(
      "keeps every vanity domain as a domain Cloudflare writes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 84)
          )
          yield* insertRows("domain_integration", {
            api_token_ciphertext: "token",
            blacklist_patterns: "[]",
            created_at: 1,
            id: "cloudflare",
            name: "Cloudflare",
            owner_id: null,
            provider: "cloudflare",
            updated_at: 1,
            zones: "[]",
          })
          yield* insertRows("domain_zone", {
            created_at: 1,
            domain: "kiln.test",
            enabled: 1,
            integration_id: "cloudflare",
            is_default: 1,
            updated_at: 1,
            zone_id: "z".repeat(32),
            zone_name: "kiln.test",
          })

          yield* applyMigrations(migrations)

          expect(
            yield* sql<Record<string, unknown>>`
              SELECT domain, provider, integration_id, zone_name, is_default
                FROM ${sql(databaseTableName("domain"))}
            `
          ).toEqual([
            {
              domain: "kiln.test",
              integration_id: "cloudflare",
              is_default: 1,
              provider: "cloudflare",
              zone_name: "kiln.test",
            },
          ])
          // A domain with no connection, as a tunnel's or one managed
          // elsewhere has, fits.
          yield* insertRows("domain", {
            created_at: 1,
            domain: "kiln",
            enabled: 1,
            is_default: 0,
            provider: "tunnel",
            updated_at: 1,
          })
        }),
      schemaBuildTimeout
    )
    it.effect(
      "keeps each tunnel's TLDs, in order, as domains the tunnel writes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 86)
          )
          const tunnelId = "a".repeat(12)
          yield* insertRows("tunnel", {
            created_at: 1,
            id: tunnelId,
            name: "Home",
            updated_at: 1,
          })
          yield* insertRows("tunnel_domain", [
            { domain: "test", position: 1, tunnel_id: tunnelId },
            { domain: "kiln", position: 0, tunnel_id: tunnelId },
          ])

          yield* applyMigrations(migrations)

          expect(
            yield* sql<Record<string, unknown>>`
              SELECT domain, provider, tunnel_id, position, is_default
                FROM ${sql(databaseTableName("domain"))}
               ORDER BY position
            `
          ).toEqual([
            {
              domain: "kiln",
              is_default: 1,
              position: 0,
              provider: "tunnel",
              tunnel_id: tunnelId,
            },
            {
              domain: "test",
              is_default: 0,
              position: 1,
              provider: "tunnel",
              tunnel_id: tunnelId,
            },
          ])
          // Deleting the tunnel takes its domains.
          yield* sql`DELETE FROM ${sql(databaseTableName("tunnel"))}`
          expect(
            yield* sql`SELECT domain FROM ${sql(databaseTableName("domain"))}`
          ).toEqual([])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "drops reading the Relay's own state from grants, presets and Relay clients, so they still load",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while the Relay's state had a tab, and a
          // permission, of its own.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 89)
          )
          const relayId = "1".repeat(12)
          yield* insertRelay(relayId, {
            client_actions: JSON.stringify([
              "relay.read",
              "relay.database.read",
              "relay.files.read",
            ]),
            client_role: "custom",
          })
          const selections = (
            owner: Record<string, string>,
            keys: ReadonlyArray<string>
          ) =>
            keys.map((key) => ({
              ...owner,
              selection_kind: key.endsWith(".all")
                ? "collection"
                : "permission",
              selection_key: key,
            }))
          const grant = Effect.fnUntraced(function* (
            id: string,
            keys: ReadonlyArray<string>
          ) {
            yield* insertUser(id)
            yield* insertGrant({
              id,
              relayId,
              resourceId: relayId,
              resourceType: "relay",
              userId: id,
            })
            yield* insertRows(
              "access_selection",
              selections({ access_id: id }, keys)
            )
          })
          yield* grant("host", ["relay.database.read", "relay.files.read"])
          yield* grant("block", ["relay.database.all", "relay.logs.all"])
          yield* grant("state", ["relay.database.read"])
          yield* insertRows("permission_preset", {
            created_at: 1,
            id: "preset",
            name: "Relay operator",
            relay_id: relayId,
            resource_id: relayId,
            resource_type: "relay",
            updated_at: 1,
          })
          yield* insertRows(
            "preset_selection",
            selections({ preset_id: "preset" }, [
              "relay.database.read",
              "relay.terminal",
            ])
          )

          yield* applyMigrations(migrations)

          const selected = (table: string, owner: string, id: string) =>
            sql<{ key: string }>`
              SELECT selection_key AS \`key\` FROM ${sql(databaseTableName(table))}
               WHERE ${sql(owner)} = ${id} ORDER BY selection_key
            `.pipe(Effect.map((rows) => rows.map((row) => row.key)))
          const granted = (id: string) =>
            selected("access_selection", "access_id", id)
          expect(yield* granted("host")).toEqual(["relay.files.read"])
          expect(yield* granted("block")).toEqual(["relay.logs.all"])
          expect(yield* granted("state")).toEqual([])
          expect(
            yield* selected("preset_selection", "preset_id", "preset")
          ).toEqual(["relay.terminal"])

          // What was stored now loads, with everything else it allowed.
          const loaded = (keys: ReadonlyArray<string>) =>
            expandStoredSelections(
              keys.map((key) => ({
                key,
                kind: key.endsWith(".all") ? "collection" : "permission",
              })),
              "relay"
            )
          expect(loaded(yield* granted("host"))).toEqual(
            expect.arrayContaining(["relay.read", "relay.files.read"])
          )
          expect(loaded(yield* granted("block"))).toEqual(
            expect.arrayContaining(["relay.read", "relay.logs.read"])
          )

          const [relay] = yield* sql<{ actions: unknown }>`
            SELECT client_actions AS actions
              FROM ${sql(databaseTableName("relay"))} WHERE id = ${relayId}
          `
          expect(
            typeof relay?.actions === "string"
              ? JSON.parse(relay.actions)
              : relay?.actions
          ).toEqual(["relay.read", "relay.files.read"])
        }),
      schemaBuildTimeout
    )

    it.effect(
      "keeps every schedule target and lets one be a volume",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth left it while a schedule backed a volume up only
          // through the Apps that use it.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 90)
          )
          const relayId = "1".repeat(12)
          const scheduleId = "5".repeat(36)
          const target = (kind: string, id: string) => ({
            created_at: 1,
            relay_id: relayId,
            schedule_id: scheduleId,
            target_id: id,
            target_kind: kind,
            target_name: kind,
          })
          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          yield* insertRows("schedule_target", target("app", "a".repeat(12)))

          yield* applyMigrations(migrations)

          yield* insertRows("schedule_target", target("volume", "f".repeat(40)))
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`
          expect(
            yield* sql<{ id: string; kind: string }>`
              SELECT target_kind AS kind, target_id AS id
                FROM ${sql(databaseTableName("schedule_target"))}
               ORDER BY target_kind
            `
          ).toEqual([
            { id: "a".repeat(12), kind: "app" },
            { id: "f".repeat(40), kind: "volume" },
          ])
        }),
      schemaBuildTimeout
    )

    // A destination's ID is in its backups, the schedules that back up to
    // it and the keys it is encrypted with. Moving it to a 12-character ID
    // has to carry all of them, or backups stop finding their bucket.
    it.effect(
      "gives a backup destination its 12-character ID everywhere it is named, its keys still readable",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const secrets = `1:${"k".repeat(32)}`
          vi.stubEnv("BETTER_AUTH_SECRETS", secrets)
          const keyring = parseSecretKeyring(secrets)
          const old = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9"
          const next = yield* Effect.promise(() =>
            migratedBackupDestinationId(old)
          )
          const relayId = "a".repeat(12)
          const backupId = "11111111-1111-4111-8111-111111111111"
          const purpose = (id: string, field: string) =>
            `kiln-backup-storage:${id}:${field}`
          yield* dropAllTables
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 91)
          )
          yield* insertUser("owner")
          yield* insertRelay(relayId)
          yield* insertBackupStorage(old, {
            // A folder someone named after the destination.
            object_prefix: `team/${old}`,
            access_key_id_ciphertext: encryptWithKeyring(
              "AKIAEXAMPLE",
              keyring,
              purpose(old, "access-key-id")
            ),
            secret_access_key_ciphertext: encryptWithKeyring(
              "s3-secret",
              keyring,
              purpose(old, "secret-access-key")
            ),
          })
          yield* insertBackup(backupId, {
            object_key: `team/${old}/backup.zip`,
            relay_id: relayId,
            storage_id: old,
          })
          yield* insertRows("backup_artifact", {
            backup_id: backupId,
            created_at: 1,
            destination_key: old,
            id: "22222222-2222-4222-8222-222222222222",
            status: "available",
            storage_id: old,
            updated_at: 1,
          })
          yield* insertRows("backup_repository", {
            created_at: 1,
            id: "33333333-3333-4333-8333-333333333333",
            object_prefix: `team/${old}/restic/one`,
            password_ciphertext: "repository-password",
            relay_id: relayId,
            storage_id: old,
            storage_key: old,
            target_id: "instance-one",
            target_kind: "instance",
          })
          const scheduleId = "44444444-4444-4444-8444-444444444444"
          yield* insertRows("schedule", {
            created_at: 1,
            created_by: "owner",
            cron_expression: "0 3 * * *",
            id: scheduleId,
            name: "Nightly",
            updated_at: 1,
          })
          yield* insertRows("schedule_action", {
            action_config: JSON.stringify({
              destination: { kind: "storage", storageId: old },
              type: "backup",
            }),
            action_type: "backup",
            created_at: 1,
            id: "55555555-5555-4555-8555-555555555555",
            position: 0,
            schedule_id: scheduleId,
          })

          yield* applyMigrations(migrations)
          // Again, as after a crash: there is nothing left to move.
          yield* backupDestinationIds.run

          const one = <T extends object>(name: string) =>
            Effect.map(
              sql<T>`SELECT * FROM ${sql(databaseTableName(name))}`,
              (rows) => rows[0]!
            )
          const destination = yield* one<{
            access_key_id_ciphertext: string
            id: string
            kind: string
            secret_access_key_ciphertext: string
          }>("backup_storage")
          // Where things are in the bucket stays, even a folder that holds
          // the old ID: the objects there don't move.
          expect(destination).toMatchObject({
            id: next,
            kind: "s3",
            object_prefix: `team/${old}`,
          })
          expect(next).toMatch(/^[a-f0-9]{12}$/u)
          expect(
            decryptWithKeyring(
              destination.secret_access_key_ciphertext,
              keyring,
              purpose(next, "secret-access-key")
            ).plaintext
          ).toBe("s3-secret")
          expect(
            decryptWithKeyring(
              destination.access_key_id_ciphertext,
              keyring,
              purpose(next, "access-key-id")
            ).plaintext
          ).toBe("AKIAEXAMPLE")
          expect(yield* one("backup")).toMatchObject({
            object_key: `team/${old}/backup.zip`,
            storage_id: next,
          })
          expect(yield* one("backup_artifact")).toMatchObject({
            destination_key: next,
            storage_id: next,
          })
          expect(yield* one("backup_repository")).toMatchObject({
            object_prefix: `team/${old}/restic/one`,
            storage_id: next,
            storage_key: next,
          })
          const step = yield* one<{ action_config: unknown }>("schedule_action")
          expect(
            typeof step.action_config === "string"
              ? JSON.parse(step.action_config)
              : step.action_config
          ).toMatchObject({ destination: { storageId: next } })
          // Reserved where instances are, so no Relay can come to hold it.
          expect(
            yield* sql<{ kind: string; legacy_id: string }>`
              SELECT kind, legacy_id FROM kiln_instance_id WHERE id = ${next}
            `
          ).toEqual([{ kind: "destination", legacy_id: old }])
          vi.unstubAllEnvs()
        }),
      schemaBuildTimeout
    )
  })
})
