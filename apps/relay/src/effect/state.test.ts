import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { BackupTaskInput } from "@workspace/contracts"

import {
  makeRelayStateLayer,
  RelayStateStore,
  RelayStateStoreLive,
} from "./state.js"
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
              scope: { instanceId: "instance-a", kind: "server" },
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
              scope: { instanceId: "instance-a", kind: "server" },
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
        target: { id: "instance-a", kind: "server" },
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
    "never runs a create that arrives after its backup's delete",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const backupId = "41100000-0000-4000-8000-000000000020"
        const target = { id: "instance-a", kind: "server" as const }
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
})

describe("Relay state from before game servers were servers", () => {
  it.effect("renames every game server's instance to server", () =>
    withTemporaryDirectory((directory) =>
      Effect.gen(function* () {
        const filename = join(directory, "relay.sqlite")
        const serverId = "5".repeat(12)
        const databaseId = "d".repeat(12)
        const relayId = "e".repeat(12)
        const now = Date.now()
        const targetKey = `${relayId}:instance:${serverId}`

        // A Relay from before `39_server_naming`: its records call game
        // servers `instance`, as its old checks allowed.
        yield* Effect.void.pipe(Effect.provide(makeRelayStateLayer(filename)))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`PRAGMA ignore_check_constraints = ON`
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 39`
          yield* sql`ALTER TABLE relay_server_names RENAME TO relay_instance_names`
          yield* sql`
            ALTER TABLE relay_server_lifecycle_events
            RENAME TO relay_instance_lifecycle_events
          `
          yield* sql`
            INSERT INTO relay_clients (
              id, name, public_key, role, actions_json, origins_json,
              created_at, invitation_id
            ) VALUES (
              'hearth-1', 'Hearth', 'key-1', 'custom',
              ${JSON.stringify([
                "instance.console.write",
                "instance.files.upload-url",
                "app.read",
              ])},
              '[]', ${now}, 'invitation-1'
            )
          `
          yield* sql`
            INSERT INTO relay_instance_names (instance_id, name, updated_at)
            VALUES (${serverId}, 'Survival', ${now})
          `
          yield* sql`
            INSERT INTO relay_resource_freezes (kind, resource_id, deletion_id, frozen_at)
            VALUES ('instance', ${serverId}, 'deletion-1', ${now})
          `
          yield* sql`
            INSERT INTO relay_database_connections (member_kind, member_id, database_id, relay_id)
            VALUES ('instance', ${serverId}, ${databaseId}, ${relayId})
          `
          yield* sql`
            INSERT INTO relay_docker_cleanups (
              container_id, owner_kind, owner_id, reason, volumes, error,
              failures, first_failed_at
            ) VALUES (
              'container-1', 'instance', ${serverId}, 'replaced', 0, 'busy',
              1, ${now}
            )
          `
          yield* sql`
            INSERT INTO relay_docker_images (image_id, owner, last_used_at)
            VALUES ('sha256:1', ${`instance:${serverId}`}, ${now})
          `
          yield* sql`
            INSERT INTO relay_browser_authorization_floors (
              issuer, subject, scope_kind, scope_id, minimum_revision, updated_at
            ) VALUES ('hearth-1', 'user-1', 'instance', ${serverId}, 5, ${now})
          `
          yield* sql`
            INSERT INTO relay_operations (
              client_id, operation_id, operation, payload_sha256, status,
              started_at
            ) VALUES (
              'hearth-1', 'operation-1', 'instance.action', 'sha', 'succeeded',
              ${now}
            )
          `
          yield* sql`
            INSERT INTO relay_audit (id, event, details_json, occurred_at)
            VALUES (
              'audit-1', 'control.mutation',
              ${JSON.stringify({
                operation: "instance.files.put",
                path: "instance.properties",
                permission: "instance.files.write",
              })},
              ${now}
            )
          `
          yield* sql`
            INSERT INTO relay_schedules (schedule_id, revision, enabled, definition_json)
            VALUES (
              'schedule-1', 1, 1,
              ${JSON.stringify({
                actions: [{ targetKeys: [targetKey], type: "power" }],
                targets: [{ id: serverId, kind: "instance", relayId }],
              })}
            )
          `
        }).pipe(Effect.provide(SqliteClient.layer({ filename })))

        // It starts on this version.
        yield* Effect.gen(function* () {
          const store = yield* RelayStateStore
          const [client] = yield* store.listClients()
          assert.deepStrictEqual(client?.actions, [
            "server.console.write",
            "server.files.upload-url",
            "app.read",
          ])
          assert.deepStrictEqual(yield* store.listServerNames(), [
            { instanceId: serverId, name: "Survival" },
          ])
          const [freeze] = yield* store.listResourceFreezes()
          assert.strictEqual(freeze?.kind, "server")
          assert.deepStrictEqual(yield* store.listDatabaseConnections(), [
            { databaseId, memberId: serverId, memberKind: "server", relayId },
          ])
          const [cleanup] = yield* store.listDockerCleanups()
          assert.deepStrictEqual(cleanup?.owner, {
            id: serverId,
            kind: "server",
          })
          const [image] = yield* store.listDockerImages()
          assert.strictEqual(image?.owner, `server:${serverId}`)
          const authority = yield* store.browserAuthority({
            instanceId: serverId,
            issuer: "hearth-1",
            loginSessionId: "session-1",
            subject: "user-1",
          })
          assert.strictEqual(authority.minimumRevision, 5)
          const operation = yield* store.getOperation("hearth-1", "operation-1")
          assert.strictEqual(operation?.operation, "server.action")
          const [audit] = yield* store.listAudits({ limit: 10 })
          // A file keeps its name.
          assert.deepStrictEqual(audit?.details, {
            operation: "server.files.put",
            path: "instance.properties",
            permission: "server.files.write",
          })
          const sql = yield* SqlClient.SqlClient
          const [schedule] = yield* sql<{ definition: string }>`
            SELECT definition_json AS definition FROM relay_schedules
          `
          assert.deepStrictEqual(JSON.parse(schedule!.definition), {
            actions: [
              {
                targetKeys: [`${relayId}:server:${serverId}`],
                type: "power",
              },
            ],
            targets: [{ id: serverId, kind: "server", relayId }],
          })
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              RelayStateStoreLive,
              SqliteClient.layer({ filename })
            )
          )
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
