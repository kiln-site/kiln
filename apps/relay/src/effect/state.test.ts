import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { BackupTaskInput } from "@workspace/contracts"

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

  // A stopped batch's archives are all taken in one window. A member that
  // holds its archive for Hearth was taken in an earlier one, so a window
  // opened after a restart mustn't count it as taken now.
  stateTest(
    "keeps a batch member that holds its archive out of the batch's next window",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const batch = {
          id: "42200000-0000-4000-8000-000000000001",
          size: 2,
        }
        const member = (index: number): BackupTaskInput => ({
          artifactKind: "tar_archive",
          backupId: `42200000-0000-4000-8000-00000000001${index}`,
          batch,
          consistency: "stopped",
          destination: {
            artifactId: `42200000-0000-4000-8000-00000000003${index}`,
            kind: "s3",
          },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "scheduled",
          target: { id: `${index}`.repeat(40), kind: "volume" },
          taskId: `42200000-0000-4000-8000-00000000002${index}`,
        })
        const [held, interrupted] = [member(1), member(2)]
        yield* store.enqueueBackupTask(held, 100, "hearth-one")
        yield* store.enqueueBackupTask(interrupted, 101, "hearth-one")
        yield* store.claimNextBackupTask(110)
        assert.strictEqual(
          yield* store.holdBackupTaskForHearth(
            held.taskId,
            {
              bytes: 10,
              checksumSha256: "a".repeat(64),
              filename: "volume.tar.gz",
              warnings: [],
            },
            120,
            1_000
          ),
          "held"
        )
        // Its Hearth is back, and its sibling is still waiting its turn.
        assert.strictEqual(
          yield* store.releaseBackupTasksHeldForHearth(130, "hearth-one"),
          1
        )

        assert.deepStrictEqual(
          (yield* store.claimBatchBackupTasks(batch.id, 140)).map(
            ({ taskId }) => taskId
          ),
          [interrupted.taskId]
        )
        // It still takes its own turn, to send what it holds.
        assert.strictEqual(
          (yield* store.claimNextBackupTask(150))?.taskId,
          held.taskId
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

  // A restore waiting its turn when the Relay updated carried a signed URL
  // and no name for the copy it reads, so it can't ask Hearth for access.
  it.effect(
    "has Hearth send again a restore from a bucket that was waiting when the Relay updated",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, RelayStateStore>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const restore = (index: number, source: object) => ({
            backupId: `43300000-0000-4000-8000-00000000001${index}`,
            kind: "restore",
            source: {
              bytes: 10,
              checksumSha256: "a".repeat(64),
              ...source,
            },
            target: { id: "instance-a", kind: "instance" },
            taskId: `43300000-0000-4000-8000-00000000002${index}`,
          })
          // As an older Hearth sent it, and as this one does.
          const signed = restore(1, {
            allowPrivateNetwork: false,
            downloadUrl: "https://s3.example.com/kiln/a.zip?X-Amz-Signature=a",
            headers: {},
            kind: "remote",
          })
          const named = restore(2, {
            artifactId: "43300000-0000-4000-8000-000000000032",
            kind: "remote",
          })
          yield* Effect.gen(function* () {
            yield* Effect.void.pipe(
              Effect.provide(makeRelayStateLayer(filename))
            )
            const sql = yield* SqlClient.SqlClient
            for (const [at, input] of [signed, named].entries()) {
              yield* sql`
                INSERT INTO relay_backup_tasks
                  (task_id, backup_id, kind, status, input_json, created_at,
                   updated_at)
                VALUES (${input.taskId}, ${input.backupId}, 'restore',
                  'queued', ${JSON.stringify(input)}, ${at}, ${at})
              `
            }
            yield* sql`
              DELETE FROM effect_sql_migrations WHERE migration_id >= 52
            `
          }).pipe(Effect.provide(SqliteClient.layer({ filename })))

          yield* open(
            Effect.gen(function* () {
              const store = yield* RelayStateStore
              assert.isTrue(
                (yield* store.getBackupTask(signed.taskId))
                  ?.inputRefreshRequired
              )
              // The one Hearth hasn't sent again yet waits; the other runs.
              assert.strictEqual(
                (yield* store.claimNextBackupTask(100))?.taskId,
                named.taskId
              )
              assert.isNull(yield* store.claimNextBackupTask(101))
            })
          )
        })
      )
  )

  it.effect(
    "drops the bucket keys a waiting backup was stored with, and keeps a restic repository's",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, SqlClient.SqlClient>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(SqliteClient.layer({ filename })))
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const keys = {
            accessKeyId: "AKIAEXAMPLE",
            allowPrivateNetwork: false,
            bucket: "kiln-backups",
            endpoint: "https://s3.example.com",
            forcePathStyle: false,
            region: "us-east-1",
            secretAccessKey: "s3-secret",
          }
          const create = (index: number, destination: object) => ({
            artifactKind: "archive",
            backupId: `43500000-0000-4000-8000-00000000001${index}`,
            destination,
            exclude: [],
            kind: "create",
            maxBytes: null,
            mode: "full",
            reason: "scheduled",
            target: { id: "instance-a", kind: "instance" },
            taskId: `43500000-0000-4000-8000-00000000002${index}`,
          })
          const artifactId = "43500000-0000-4000-8000-000000000031"
          const archive = create(1, {
            ...keys,
            artifactId,
            kind: "s3",
            objectKey: "team/kiln/a.zip",
          })
          const snapshot = {
            ...create(2, {
              kind: "restic",
              repository: { ...keys, kind: "s3", prefix: "team/restic/a" },
              repositoryPassword: "repository-password",
            }),
            artifactKind: "restic_snapshot",
            mode: "incremental",
          }
          const stored = (taskId: string) =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql<{ input_json: string }>`
                SELECT input_json FROM relay_backup_tasks
                WHERE task_id = ${taskId}
              `
              return JSON.parse(rows[0]!.input_json) as {
                destination: unknown
              }
            })
          yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              for (const [at, input] of [archive, snapshot].entries()) {
                yield* sql`
                  INSERT INTO relay_backup_tasks
                    (task_id, backup_id, kind, status, input_json, created_at,
                     updated_at)
                  VALUES (${input.taskId}, ${input.backupId}, 'create',
                    'queued', ${JSON.stringify(input)}, ${at}, ${at})
                `
              }
              yield* sql`
                DELETE FROM effect_sql_migrations WHERE migration_id >= 53
              `
            })
          )
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))

          yield* open(
            Effect.gen(function* () {
              assert.deepStrictEqual((yield* stored(archive.taskId)).destination, {
                artifactId,
                kind: "s3",
              })
              assert.deepStrictEqual(
                (yield* stored(snapshot.taskId)).destination,
                snapshot.destination
              )
            })
          )
        })
      )
  )

  it.effect(
    "drops the bucket keys a stored schedule carried for its full backups, and keeps the rest of it",
    () =>
      withTemporaryDirectory((directory) =>
        Effect.gen(function* () {
          const filename = join(directory, "relay.sqlite")
          const open = <A, E>(
            use: Effect.Effect<A, E, SqlClient.SqlClient>
          ): Effect.Effect<A, unknown> =>
            use.pipe(Effect.provide(SqliteClient.layer({ filename })))
          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const repository = {
            accessKeyId: "AKIAREPOSITORY",
            bucket: "kiln-backups",
            kind: "s3",
            secretAccessKey: "repository-secret",
          }
          // As a Hearth sent it while a schedule carried a bucket's keys.
          const stored = {
            actions: [
              { id: "wait", type: "wait" },
              {
                executions: [
                  {
                    destination: {
                      accessKeyId: "AKIAARCHIVE",
                      bucket: "kiln-backups",
                      endpoint: "https://s3.example.com",
                      kind: "s3",
                      objectKeyPrefix: "team/kiln/install/relay/instance/one",
                      region: "us-east-1",
                      secretAccessKey: "archive-secret",
                    },
                    mode: "full",
                    targetId: "one",
                    targetKind: "instance",
                  },
                  {
                    destination: { kind: "local" },
                    mode: "full",
                    targetId: "two",
                    targetKind: "instance",
                  },
                  {
                    destination: {
                      kind: "restic",
                      repository,
                      repositoryPassword: "repository-password",
                    },
                    mode: "incremental",
                    targetId: "three",
                    targetKind: "instance",
                  },
                ],
                id: "backup",
                type: "backup",
              },
            ],
            id: "schedule-1",
            name: "Nightly",
          }
          yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`
                INSERT INTO relay_schedules
                  (schedule_id, revision, enabled, next_run_at, definition_json)
                VALUES ('schedule-1', 1, 1, NULL, ${JSON.stringify(stored)})
              `
              yield* sql`
                DELETE FROM effect_sql_migrations WHERE migration_id >= 51
              `
            })
          )

          yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
          const [row] = yield* open(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{ definition_json: string }>`
                SELECT definition_json FROM relay_schedules
              `
            })
          )
          assert.notMatch(
            row?.definition_json ?? "",
            /AKIAARCHIVE|archive-secret|objectKeyPrefix/u
          )
          const [bucket, local, incremental] = (
            JSON.parse(row?.definition_json ?? "{}") as typeof stored
          ).actions[1]!.executions!
          assert.deepStrictEqual(bucket?.destination, { kind: "s3" })
          assert.deepStrictEqual(local, stored.actions[1]!.executions![1])
          // An incremental backup's repository still reaches the bucket with
          // them.
          assert.deepStrictEqual(
            incremental,
            stored.actions[1]!.executions![2]
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
