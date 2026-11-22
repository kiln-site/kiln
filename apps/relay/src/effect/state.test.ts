import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  migratedBackupDestinationId,
  type BackupTaskInput,
} from "@workspace/contracts"

import { makeRelayStateLayer, RelayStateStore } from "./state.js"
import { BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS } from "../browser-security.js"

describe("Relay state", () => {
  stateTest("pairs a client exactly once and persists its grant", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const now = Date.UTC(2026, 0, 1)
      yield* store.createInvitation({
        actions: ["*"],
        createdAt: now,
        expiresAt: now + 15 * 60_000,
        id: "invitation-1",
        role: "full_access",
        tokenHash: "hash-1",
      })
      const invitation = yield* store.findActiveInvitation("invitation-1", now)
      assert.isNotNull(invitation)
      if (!invitation) return
      assert.lengthOf(yield* store.listInvitations(now), 1)

      yield* store.pairClient({
        actions: invitation.actions,
        id: "hearth-1",
        invitationId: invitation.id,
        name: "Hearth One",
        origins: ["https://hearth.test"],
        pairedAt: now + 1,
        publicKey: "public-key-1",
        role: invitation.role,
        sourceCidrs: [],
      })
      assert.isNull(yield* store.findActiveInvitation("invitation-1", now + 2))
      const paired = yield* store.findClientByPublicKey("public-key-1")
      assert.deepStrictEqual(paired, {
        actions: ["*"],
        id: "hearth-1",
        invitationId: invitation.id,
        name: "Hearth One",
        origins: ["https://hearth.test"],
        publicKey: "public-key-1",
        role: "full_access",
        sourceCidrs: [],
        createdAt: now + 1,
        lastAddress: null,
        lastSeenAt: now + 1,
      })

      assert.isTrue(
        yield* store.updateClient({
          actions: ["relay.read"],
          clientId: "hearth-1",
          name: "Hearth Renamed",
          role: "read_only",
          sourceCidrs: ["192.0.2.1/32"],
        })
      )
      yield* store.touchClient("hearth-1", now + 2, "192.0.2.1")
      const updated = yield* store.findClientById("hearth-1")
      assert.strictEqual(updated?.name, "Hearth Renamed")
      assert.strictEqual(updated?.lastAddress, "192.0.2.1")
      assert.deepStrictEqual(updated?.sourceCidrs, ["192.0.2.1/32"])

      const duplicate = yield* Effect.result(
        store.pairClient({
          actions: invitation.actions,
          id: "hearth-2",
          invitationId: invitation.id,
          name: "Hearth Two",
          origins: [],
          pairedAt: now + 3,
          publicKey: "public-key-2",
          role: invitation.role,
          sourceCidrs: [],
        })
      )
      assert.strictEqual(duplicate._tag, "Failure")
    })
  )

  stateTest("revokes clients without deleting their durable record", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const now = Date.UTC(2026, 0, 1)
      yield* store.createInvitation({
        actions: ["*"],
        createdAt: now,
        expiresAt: now + 15 * 60_000,
        id: "invitation-1",
        role: "full_access",
        tokenHash: "hash-1",
      })
      yield* store.pairClient({
        actions: ["*"],
        id: "hearth-1",
        invitationId: "invitation-1",
        name: "Hearth One",
        origins: ["https://hearth.test"],
        pairedAt: now + 1,
        publicKey: "public-key-1",
        role: "full_access",
        sourceCidrs: [],
      })
      assert.isTrue(yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 2)))
      assert.isNull(yield* store.findClientById("hearth-1"))
      assert.isNull(yield* store.findClientByPublicKey("public-key-1"))
      assert.isFalse(
        yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 3))
      )
    })
  )

  stateTest(
    "persists monotonic browser floors and bounded replay entries",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const now = Date.UTC(2026, 0, 4)
        const first = yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 7,
              scope: { instanceId: "instance-a", kind: "instance" },
              subject: "user-a",
            },
            {
              minimumRevision: 9,
              scope: {
                kind: "login_session",
                loginSessionId: "session-a",
              },
              subject: "user-a",
            },
          ],
          3,
          now
        )
        assert.strictEqual(first.issuerGeneration, 3)
        assert.strictEqual(
          (yield* store.browserAuthority({
            instanceId: "instance-a",
            issuer: "browser-issuer",
            loginSessionId: "session-a",
            subject: "user-a",
          })).minimumRevision,
          9
        )
        const stale = yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 2,
              scope: { instanceId: "instance-a", kind: "instance" },
              subject: "user-a",
            },
          ],
          1,
          now + 1
        )
        assert.strictEqual(stale.issuerGeneration, 3)
        assert.strictEqual(stale.items[0]?.minimumRevision, 7)

        yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 10,
              scope: { kind: "subject_relay" },
              subject: "user-b",
            },
          ],
          undefined,
          now + BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS + 1
        )
        assert.strictEqual(
          (yield* store.browserAuthority({
            instanceId: "instance-a",
            issuer: "browser-issuer",
            loginSessionId: "session-a",
            subject: "user-a",
          })).minimumRevision,
          0
        )

        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-a",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-a",
            now,
          }),
          "reserved"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-a",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-a",
            now,
          }),
          "replayed"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-b",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-b",
            now,
          }),
          "full"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-b",
            expiresAt: now + 120_000,
            maxEntries: 1,
            nonce: "nonce-b",
            now: now + 60_001,
          }),
          "reserved"
        )
      })
  )

  stateTest("scrubs S3 keys from terminal journal rows", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const input: BackupTaskInput = {
        artifactKind: "restic_snapshot",
        backupId: "41100000-0000-4000-8000-000000000001",
        destination: {
          kind: "restic",
          repository: {
            accessKeyId: "AKIAEXAMPLE",
            allowPrivateNetwork: true,
            bucket: "kiln-backups",
            endpoint: "https://s3.example.com",
            forcePathStyle: true,
            kind: "s3",
            region: "us-east-1",
            repositoryPrefix: "team/repo",
            secretAccessKey: "s3-secret",
          },
          repositoryPassword: "repo-secret",
        },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "incremental",
        reason: "manual",
        target: { id: "instance-a", kind: "instance" },
        taskId: "41100000-0000-4000-8000-000000000011",
      }
      yield* store.enqueueBackupTask(input, 530)
      yield* store.claimNextBackupTask(540)
      assert.isTrue(
        yield* store.completeBackupTask(
          input.taskId,
          {
            bytes: 12,
            snapshotId: "abcdef12",
            warnings: [],
          },
          550
        )
      )
      const completed = yield* store.getBackupTask(input.taskId)
      const destination =
        completed?.input.kind === "create" &&
        completed.input.destination.kind === "restic"
          ? completed.input.destination
          : null
      assert.isDefined(destination)
      if (!destination) return
      assert.strictEqual(destination.repositoryPassword, undefined)
      assert.strictEqual(
        destination.repository?.kind === "s3"
          ? destination.repository.accessKeyId
          : "present",
        undefined
      )
      assert.strictEqual(
        destination.repository?.kind === "s3"
          ? destination.repository.secretAccessKey
          : "present",
        undefined
      )
    })
  )

  stateTest(
    "cancels a create only when Hearth names it as the Relay holds it",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const backupId = "41100000-0000-4000-8000-000000000030"
        const target = { id: "instance-a", kind: "instance" as const }
        const taskId = "41100000-0000-4000-8000-000000000031"
        yield* store.enqueueBackupTask(
          {
            artifactKind: "archive",
            backupId,
            destination: { kind: "local" },
            exclude: [],
            kind: "create",
            maxBytes: null,
            mode: "full",
            reason: "manual",
            target,
            taskId,
          },
          700
        )

        // Named for another backup, then for another resource: left alone.
        for (const expected of [
          { backupId: "41100000-0000-4000-8000-000000000039", target },
          { backupId, target: { id: "instance-b", kind: "instance" as const } },
        ]) {
          assert.isFalse(
            yield* store.cancelBackupTask(taskId, 710, undefined, null, expected)
          )
          assert.strictEqual((yield* store.getBackupTask(taskId))?.status, "queued")
        }

        assert.isTrue(
          yield* store.cancelBackupTask(taskId, 720, undefined, null, {
            backupId,
            target,
          })
        )
        assert.strictEqual(
          (yield* store.getBackupTask(taskId))?.status,
          "cancelled"
        )
      })
  )

  stateTest(
    "pages the backup journal for Hearth in the order tasks changed, with what's unfinished on every page",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const id = (n: number) =>
          `41200000-0000-4000-8000-${String(n).padStart(12, "0")}`
        const create = (n: number, now: number) =>
          store.enqueueBackupTask(
            {
              artifactKind: "archive",
              backupId: id(100 + n),
              destination: { kind: "local" },
              exclude: [],
              kind: "create",
              maxBytes: null,
              mode: "full",
              reason: "manual",
              target: { id: `instance-${n}`, kind: "instance" },
              taskId: id(n),
            },
            now
          )
        // Nine creates. All but the last end, three of them at the same
        // moment.
        for (let n = 1; n <= 9; n += 1) yield* create(n, 1_000 + n * 10)
        for (let n = 1; n <= 8; n += 1) {
          const at = n >= 4 && n <= 6 ? 2_005 : 2_000 + n
          assert.isTrue(yield* store.failBackupTask(id(n), "It failed", at))
        }
        const oneTask = Buffer.byteLength(
          JSON.stringify((yield* store.getBackupTask(id(1)))!)
        )

        // Pages of about three tasks, asking after one ended task by ID.
        const seen: Array<string> = []
        let after = { taskId: "", updatedAt: 0 }
        let pages = 0
        for (;;) {
          const page = yield* store.backupTaskPage({
            after,
            budgetBytes: oneTask * 3.5,
            taskIds: [id(2)],
          })
          pages += 1
          // What's unfinished, and the one asked after, on every page.
          assert.sameMembers(
            page.current.map((task) => task.taskId),
            pages === 1 ? [id(2), id(9)] : [id(2)]
          )
          seen.push(...page.changed.map((task) => task.taskId))
          // A task that changes after its page was read comes again later.
          if (pages === 1) {
            assert.isTrue(yield* store.failBackupTask(id(9), "Late", 9_000))
          }
          if (!page.next) break
          after = page.next
        }

        // Each comes once, in the order they changed, but for what a page
        // already carries as current: the create while it was queued, and
        // the one asked after.
        assert.isAbove(pages, 2)
        assert.deepStrictEqual(seen, [...[1, 3, 4, 5, 6, 7, 8].map(id), id(9)])
      })
  )

  stateTest(
    "removes finished backup tasks a week old, keeping the latest and unfinished",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const day = 24 * 60 * 60_000
        const id = (n: number) =>
          `41400000-0000-4000-8000-${String(n).padStart(12, "0")}`
        const create = (n: number, at: number) =>
          store.enqueueBackupTask(
            {
              artifactKind: "archive",
              backupId: id(1_000 + n),
              destination: { kind: "local" },
              exclude: [],
              kind: "create",
              maxBytes: null,
              mode: "full",
              reason: "manual",
              target: { id: `instance-${n}`, kind: "instance" },
              taskId: id(n),
            },
            at
          )
        // Thirty finished creates, ending a day apart, and one still queued
        // from the first day.
        for (let n = 1; n <= 30; n += 1) {
          yield* create(n, n * day - 1_000)
          assert.isTrue(
            yield* store.failBackupTask(id(n), "It failed", n * day)
          )
        }
        yield* create(31, day)

        const keptFrom = (first: number) =>
          Effect.gen(function* () {
            const page = yield* store.backupTaskPage({
              after: { taskId: "", updatedAt: 0 },
              budgetBytes: 10_000_000,
              taskIds: [],
            })
            const left = new Set(
              [...page.changed, ...page.current].map((task) => task.taskId)
            )
            for (let n = 1; n <= 31; n += 1) {
              assert.strictEqual(left.has(id(n)), n >= first, `task ${n}`)
            }
          })

        // On day 15, those that ended before day 8 are a week old.
        yield* store.pruneBackupJournal(15 * day)
        yield* keptFrom(8)
        // On day 33, those that ended before day 26 are, but the latest
        // twenty finished (days 11 to 30) stay.
        yield* store.pruneBackupJournal(33 * day)
        yield* keptFrom(11)
      })
  )

  stateTest("never runs a create that arrives after its backup's delete", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const backupId = "41100000-0000-4000-8000-000000000020"
      const target = { id: "instance-a", kind: "instance" as const }
      // Hearth deleted the backup while the create it had sent was still
      // on its way.
      yield* store.enqueueBackupTask(
        {
          backupId,
          destination: { kind: "local" },
          kind: "delete",
          target,
          taskId: "41100000-0000-4000-8000-000000000021",
        },
        600
      )
      const create = yield* store.enqueueBackupTask(
        {
          artifactKind: "archive",
          backupId,
          destination: { kind: "local" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target,
          taskId: "41100000-0000-4000-8000-000000000022",
        },
        610
      )

      assert.strictEqual(create.status, "cancelled")
      const delete_ = yield* store.claimNextBackupTask(620)
      assert.strictEqual(delete_?.kind, "delete")
      assert.isNull(yield* store.claimNextBackupTask(630))
    })
  )

  it.effect(
    "keeps the routes marked primary for Hearth to take once it keeps primary addresses",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, RelayStateStore>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const route = (id: string, hostname: string) => ({
            hostname,
            httpsRedirect: true,
            id,
            name: "",
            path: null,
            redirect: null,
            stripPrefix: true,
            targetPort: 8_080,
            www: "none" as const,
          })
          yield* open(
            Effect.gen(function* () {
              const store = yield* RelayStateStore
              yield* store.replaceInstanceRoutes("a".repeat(12), [
                route("aaaaaaaa", "one.example.com"),
                route("bbbbbbbb", "two.example.com"),
              ])
            })
          )
          // As a Relay left them while it kept which route was primary.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`DROP TABLE relay_carried_primary_routes`
            yield* sql`
              ALTER TABLE relay_web_routes ADD COLUMN is_primary INTEGER
              NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
            `
            yield* sql`
              UPDATE relay_web_routes SET is_primary = 1 WHERE id = 'bbbbbbbb'
            `
            yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 47`
          }).pipe(Effect.provide(SqliteClient.layer({ filename })))

          yield* open(
            Effect.gen(function* () {
              const store = yield* RelayStateStore
              assert.deepStrictEqual(yield* store.listCarriedPrimaryRoutes(), [
                { instanceId: "a".repeat(12), routeId: "bbbbbbbb" },
              ])
              assert.lengthOf(yield* store.listWebRoutes(), 2)
              yield* store.forgetCarriedPrimaryRoutes(["bbbbbbbb"])
              assert.deepStrictEqual(
                yield* store.listCarriedPrimaryRoutes(),
                []
              )
            })
          )
        })
      )
  )

  it.effect(
    "keeps what a client or invitation could do to an App's files, to a database's and an App's power, to deploy an App or change its limits, and to open its shell, as the actions every instance takes, and drops reading the Relay's own state",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const now = Date.UTC(2026, 0, 1)
          const open = <A, E>(
            use: Effect.Effect<A, E, RelayStateStore>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const invitation = (id: string, actions: ReadonlyArray<string>) => ({
            actions,
            createdAt: now,
            expiresAt: now + 15 * 60_000,
            id,
            role: "custom" as const,
            tokenHash: `hash-${id}`,
          })

          // As a Relay left them while an App's files had actions of their
          // own: a paired client that may read and upload them, and an
          // invitation not yet used that may change them.
          yield* open(
            Effect.gen(function* () {
              const store = yield* RelayStateStore
              const used = invitation("used", [
                "app.read",
                "app.files.read",
                "app.files.upload",
                "instance.files.read",
                "database.power",
                "app.terminal",
                "app.logs.read",
                "database.logs.read",
                "relay.database.read",
              ])
              yield* store.createInvitation(used)
              yield* store.pairClient({
                actions: used.actions,
                id: "hearth-1",
                invitationId: used.id,
                name: "Hearth One",
                origins: ["https://hearth.test"],
                pairedAt: now + 1,
                publicKey: "public-key-1",
                role: "custom",
                sourceCidrs: [],
              })
              yield* store.createInvitation(
                invitation("unused", [
                  "app.files.write",
                  "app.manage",
                  "relay.database.read",
                ])
              )
            })
          )
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            // The migrator runs what follows the newest one it recorded.
            yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 40`
          }).pipe(Effect.provide(SqliteClient.layer({ filename })))

          yield* open(
            Effect.gen(function* () {
              const store = yield* RelayStateStore
              assert.deepStrictEqual(
                (yield* store.findClientById("hearth-1"))?.actions,
                [
                  "app.read",
                  "instance.files.list",
                  "instance.files.read",
                  "instance.files.upload",
                  "instance.power.start",
                  "instance.power.stop",
                  "instance.power.restart",
                  "instance.power.kill",
                  "instance.terminal",
                  "instance.logs.read",
                ]
              )
              assert.deepStrictEqual(
                (yield* store.findActiveInvitation("unused", now + 2))?.actions,
                [
                  "instance.files.write",
                  "instance.files.delete",
                  "instance.files.rename",
                  "instance.files.upload-url",
                  // Configuring an App stays, with the web routes, the
                  // limits, the deploying and the power it covered.
                  "app.manage",
                  "instance.network.write",
                  "instance.limits.write",
                  "instance.deploy",
                  "instance.power.start",
                  "instance.power.stop",
                  "instance.power.restart",
                  "instance.power.kill",
                ]
              )
            })
          )
        })
      )
  )
})

describe("Relay state from before destinations took 12-character IDs", () => {
  it.effect(
    "moves the destination its stored schedules and backups name to the ID Hearth gives it",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, SqlClient.SqlClient>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(SqliteClient.layer({ filename })))
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const old = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9"
          const next = yield* Effect.promise(() =>
            migratedBackupDestinationId(old)
          )
          const schedule = {
            actions: [
              { destination: { kind: "local" }, type: "backup" },
              {
                destination: { kind: "storage", storageId: old },
                type: "backup",
              },
              { command: "say hi", type: "console_command" },
            ],
            id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
          }
          const task = {
            backupId: "43500000-0000-4000-8000-000000000011",
            catalog: { name: "Nightly", storageId: old },
            kind: "create",
            taskId: "43500000-0000-4000-8000-000000000021",
          }
          yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`
                INSERT INTO relay_schedules
                  (schedule_id, revision, enabled, next_run_at, definition_json)
                VALUES (${schedule.id}, 1, 1, NULL, ${JSON.stringify(schedule)})
              `
              yield* sql`
                INSERT INTO relay_backup_tasks
                  (task_id, backup_id, kind, status, input_json, created_at,
                   updated_at)
                VALUES (${task.taskId}, ${task.backupId}, 'create', 'queued',
                  ${JSON.stringify(task)}, 1, 1)
              `
              yield* sql`
                DELETE FROM effect_sql_migrations WHERE migration_id >= 50
              `
            })
          )
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))

          yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const [stored] = yield* sql<{ json: string }>`
                SELECT definition_json AS json FROM relay_schedules
              `
              assert.deepStrictEqual(JSON.parse(stored!.json), {
                ...schedule,
                actions: [
                  schedule.actions[0],
                  {
                    destination: { kind: "storage", storageId: next },
                    type: "backup",
                  },
                  schedule.actions[2],
                ],
              })
              const [queued] = yield* sql<{ json: string }>`
                SELECT input_json AS json FROM relay_backup_tasks
              `
              assert.deepStrictEqual(JSON.parse(queued!.json), {
                ...task,
                catalog: { name: "Nightly", storageId: next },
              })
            })
          )
        })
      )
  )
})

describe("Relay state from when schedules came with a bucket's keys", () => {
  it.effect(
    "drops the keys its stored schedules and waiting backups hold, and nothing else",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, SqlClient.SqlClient>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(SqliteClient.layer({ filename })))
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const execution = { mode: "full", targetKind: "instance" }
          const keyed = "51000000-0000-4000-8000-000000000001"
          const signed = "51000000-0000-4000-8000-000000000002"
          const copy = {
            artifactId: "51000000-0000-4000-8000-000000000003",
            kind: "s3",
            objectKey: "team/kiln/kiln/relay/instance/server-a/x/backup.zip",
          }
          const schedule = {
            actions: [
              {
                executions: [
                  {
                    ...execution,
                    destination: {
                      accessKeyId: "AKIAKILNTESTKEY",
                      allowPrivateNetwork: false,
                      bucket: "kiln-backups",
                      endpoint: "https://s3.example.test",
                      forcePathStyle: false,
                      kind: "s3",
                      objectKeyPrefix: "team/kiln/kiln/relay/instance/server-a",
                      region: "us-east-1",
                      secretAccessKey: "kiln-test-secret-access-key",
                    },
                    targetId: "server-a",
                  },
                  {
                    ...execution,
                    destination: { kind: "local" },
                    targetId: "server-b",
                  },
                ],
                type: "backup",
              },
              { command: "say hi", type: "console_command" },
            ],
            id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
          }
          yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`
              INSERT INTO relay_schedules
                (schedule_id, revision, enabled, next_run_at, definition_json)
              VALUES (${schedule.id}, 1, 1, NULL, ${JSON.stringify(schedule)})
            `
              // A scheduled backup still to be made with the bucket's keys,
              // and a manual one Hearth signed an upload for.
              for (const [taskId, destination] of [
                [
                  keyed,
                  {
                    ...copy,
                    accessKeyId: "AKIAKILNTESTKEY",
                    secretAccessKey: "kiln-test-secret-access-key",
                  },
                ],
                [
                  signed,
                  {
                    ...copy,
                    headers: {},
                    uploadUrl: "https://s3.example.test/signed",
                  },
                ],
              ] as const) {
                const input = {
                  artifactKind: "archive",
                  backupId: taskId,
                  destination,
                  kind: "create",
                  reason: taskId === keyed ? "scheduled" : "manual",
                  taskId,
                }
                yield* sql`
                INSERT INTO relay_backup_tasks
                  (task_id, backup_id, kind, status, input_json, created_at,
                   updated_at)
                VALUES (${taskId}, ${taskId}, 'create', 'queued',
                  ${JSON.stringify(input)}, 1, 1)
              `
              }
              yield* sql`
              DELETE FROM effect_sql_migrations WHERE migration_id >= 51
            `
            })
          )
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))

          const tasks = yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{ id: string; json: string; status: string }>`
              SELECT task_id AS id, input_json AS json, status
              FROM relay_backup_tasks ORDER BY task_id
            `
            })
          )
          // The keyed one fails, keeping nothing of the keys; the signed one
          // is left to run.
          assert.deepStrictEqual(
            tasks.map(({ id, status }) => [id, status]),
            [
              [keyed, "failed"],
              [signed, "queued"],
            ]
          )
          assert.notInclude(tasks[0]!.json, "AKIAKILNTESTKEY")
          assert.notInclude(tasks[0]!.json, "kiln-test-secret-access-key")
          assert.include(tasks[1]!.json, "https://s3.example.test/signed")

          const [stored] = yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{ json: string }>`
              SELECT definition_json AS json FROM relay_schedules
            `
            })
          )
          const [bucket, disk] = schedule.actions[0]!.executions!
          assert.deepStrictEqual(JSON.parse(stored!.json), {
            ...schedule,
            actions: [
              {
                executions: [{ ...bucket, destination: { kind: "s3" } }, disk],
                type: "backup",
              },
              schedule.actions[1],
            ],
          })
        })
      )
  )
})

/** Gives each test its own SQLite file so tests never share rows or run order. */
function stateTest(
  name: string,
  body: (filename: string) => Effect.Effect<unknown, unknown, RelayStateStore>
) {
  it.effect(name, () =>
    withTemporaryDirectory((directory) => {
      const filename = join(directory, "relay.sqlite")
      return body(filename).pipe(Effect.provide(makeRelayStateLayer(filename)))
    })
  )
}

function withTemporaryDirectory<A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-relay-state-"))),
    use,
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}
