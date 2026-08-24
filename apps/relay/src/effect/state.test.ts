import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, assert, describe, it, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { BackupTaskInput, BackupTaskResult } from "@workspace/contracts"
import {
  relayCreateInstanceSchema,
  relayInstanceSchema,
} from "@workspace/contracts"

import {
  makeRelayStateLayer,
  RelayStateStore,
  scrubBackupTaskInputJson,
} from "./state.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-relay-state-"))
const stateDatabase = join(testDirectory, "relay.sqlite")

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("Relay state", () => {
  layer(makeRelayStateLayer(stateDatabase))((it) => {
    it.effect("pairs a client exactly once and persists its grant", () =>
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
        const invitation = yield* store.findActiveInvitation(
          "invitation-1",
          now
        )
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
        assert.isNull(
          yield* store.findActiveInvitation("invitation-1", now + 2)
        )
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

    it.effect("re-enrolls the same client with a new invitation", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const now = Date.UTC(2026, 0, 2)
        yield* store.createInvitation({
          actions: ["relay.read"],
          createdAt: now,
          expiresAt: now + 15 * 60_000,
          id: "repair-invitation-1",
          role: "read_only",
          tokenHash: "repair-hash-1",
        })
        yield* store.pairClient({
          actions: ["relay.read"],
          id: "repair-hearth-1",
          invitationId: "repair-invitation-1",
          name: "Hearth Before Repair",
          origins: ["https://old.hearth.test"],
          pairedAt: now + 1,
          publicKey: "repair-public-key-1",
          role: "read_only",
          sourceCidrs: ["192.0.2.1/32"],
        })
        yield* store.createInvitation({
          actions: ["*"],
          createdAt: now + 2,
          expiresAt: now + 15 * 60_000,
          id: "repair-invitation-2",
          role: "full_access",
          tokenHash: "repair-hash-2",
        })
        yield* store.pairClient({
          actions: ["*"],
          id: "repair-hearth-1",
          invitationId: "repair-invitation-2",
          name: "Hearth After Repair",
          origins: ["https://new.hearth.test"],
          pairedAt: now + 3,
          publicKey: "repair-public-key-1",
          role: "full_access",
          sourceCidrs: [],
        })

        const repaired = yield* store.findClientById("repair-hearth-1")
        assert.deepInclude(repaired, {
          actions: ["*"],
          createdAt: now + 1,
          invitationId: "repair-invitation-2",
          name: "Hearth After Repair",
          origins: ["https://new.hearth.test"],
          role: "full_access",
          sourceCidrs: [],
        })
        assert.isNull(
          yield* store.findActiveInvitation("repair-invitation-2", now + 4)
        )
      })
    )

    it.effect(
      "lists and revokes pending invitations without exposing reuse",
      () =>
        Effect.gen(function* () {
          const store = yield* RelayStateStore
          const now = Date.UTC(2026, 0, 1)
          yield* store.createInvitation({
            actions: ["relay.read"],
            createdAt: now,
            expiresAt: now + 60_000,
            id: "invitation-2",
            role: "read_only",
            tokenHash: "hash-2",
          })
          assert.isTrue(yield* store.revokeInvitation("invitation-2", now + 1))
          assert.isNull(
            yield* store.findActiveInvitation("invitation-2", now + 2)
          )
          assert.isFalse(yield* store.revokeInvitation("invitation-2", now + 3))
        })
    )

    it.effect("revokes clients without deleting their durable record", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        assert.isTrue(
          yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 2))
        )
        assert.isNull(yield* store.findClientByPublicKey("public-key-1"))
        assert.isFalse(
          yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 3))
        )
      })
    )

    it.effect("returns bounded security audit history newest first", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        yield* store.appendAudit({
          clientId: "hearth-audit",
          details: { role: "read_only" },
          event: "client.updated",
          id: "audit-1",
          occurredAt: 10,
          requestId: "request-1",
        })
        yield* store.appendAudit({
          clientId: "hearth-audit",
          details: {},
          event: "client.revoked",
          id: "audit-2",
          occurredAt: 20,
          requestId: "request-2",
        })
        const audits = yield* store.listAudits({ limit: 1 })
        assert.lengthOf(audits, 1)
        assert.strictEqual(audits[0]?.id, "audit-2")
      })
    )

    it.effect("filters security audit history by occurrence time", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const audits = yield* store.listAudits({
          from: 15,
          limit: 20,
          to: 25,
        })
        assert.deepStrictEqual(
          audits.map((audit) => audit.id),
          ["audit-2"]
        )
      })
    )

    it.effect("filters instance audits before applying the result limit", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        yield* store.appendAudit({
          clientId: "hearth-audit",
          details: { instanceId: "instance-other" },
          event: "control.mutation",
          id: "audit-other-instance",
          occurredAt: 40,
          requestId: "request-other-instance",
        })
        yield* store.appendAudit({
          clientId: "hearth-audit",
          details: { instanceId: "instance-allowed" },
          event: "control.mutation",
          id: "audit-allowed-instance",
          occurredAt: 30,
          requestId: "request-allowed-instance",
        })

        const audits = yield* store.listAudits({
          instanceIds: ["instance-allowed"],
          limit: 1,
        })

        assert.deepStrictEqual(
          audits.map((audit) => audit.id),
          ["audit-allowed-instance"]
        )
      })
    )

    it.effect("persists Relay-owned instance names", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        yield* store.setInstanceName("instance-a", "Survival")
        yield* store.setInstanceName("instance-b", "Creative")
        assert.deepStrictEqual(yield* store.listInstanceNames(), [
          { instanceId: "instance-a", name: "Survival" },
          { instanceId: "instance-b", name: "Creative" },
        ])

        yield* store.setInstanceName("instance-a", "Survival SMP")
        yield* store.setInstanceName("instance-b", "Survival SMP")
        assert.deepStrictEqual(yield* store.listInstanceNames(), [
          { instanceId: "instance-a", name: "Survival SMP" },
          { instanceId: "instance-b", name: "Survival SMP" },
        ])

        yield* store.deleteInstanceName("instance-a")
        assert.deepStrictEqual(yield* store.listInstanceNames(), [
          { instanceId: "instance-b", name: "Survival SMP" },
        ])
      })
    )

    it.effect("persists pending primary ports until they are applied", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        yield* store.setPendingPrimaryPort("instance-a", {
          internalPort: 25_565,
          protocol: "tcp",
        })
        assert.deepStrictEqual(
          yield* store.getPendingPrimaryPort("instance-a"),
          {
            id: "primary",
            instanceId: "instance-a",
            internalPort: 25_565,
            name: "Default Server",
            protocol: "tcp",
          }
        )

        yield* store.setPendingPrimaryPort("instance-a", {
          internalPort: 19_132,
          protocol: "udp",
        })
        assert.deepStrictEqual(yield* store.listPendingPrimaryPorts(), [
          {
            id: "primary",
            instanceId: "instance-a",
            internalPort: 19_132,
            name: "Default Server",
            protocol: "udp",
          },
        ])

        yield* store.deletePendingPrimaryPort("instance-a")
        assert.isNull(yield* store.getPendingPrimaryPort("instance-a"))
      })
    )

    it.effect("persists readiness by exact container session", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const first = {
          instanceId: "ready-instance",
          readyAt: "2026-08-24T01:00:15.000Z",
          startedAt: "2026-08-24T01:00:00.000Z",
        }
        yield* store.setReadySession(first)
        assert.deepStrictEqual(yield* store.listReadySessions(), [first])

        const replacement = {
          ...first,
          readyAt: "2026-08-24T02:00:20.000Z",
          startedAt: "2026-08-24T02:00:00.000Z",
        }
        yield* store.setReadySession(replacement)
        assert.deepStrictEqual(yield* store.listReadySessions(), [replacement])

        yield* store.deleteReadySession(first.instanceId)
        assert.isEmpty(yield* store.listReadySessions())
      })
    )

    it.effect(
      "replaces instance web routes and rejects hostname collisions",
      () =>
        Effect.gen(function* () {
          const store = yield* RelayStateStore
          const first = {
            hostname: "map.example.com",
            id: "15c524a6",
            name: "Live Map",
            path: null,
            stripPrefix: true,
            targetPort: 8080,
          }
          yield* store.replaceInstanceRoutes("instance-a", [first])
          assert.deepStrictEqual(
            yield* store.listInstanceRoutes("instance-a"),
            [first]
          )
          assert.deepInclude((yield* store.listWebRoutes())[0], {
            ...first,
            instanceId: "instance-a",
          })

          const collision = yield* Effect.result(
            store.replaceInstanceRoutes("instance-b", [
              {
                ...first,
                id: "d76cfc41",
              },
            ])
          )
          assert.strictEqual(collision._tag, "Failure")
          assert.isEmpty(yield* store.listInstanceRoutes("instance-b"))

          yield* store.replaceInstanceRoutes("instance-a", [])
          assert.isEmpty(yield* store.listWebRoutes())
        })
    )

    it.effect("journals backup tasks idempotently and in queue order", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const first: BackupTaskInput = {
          artifactKind: "archive",
          backupId: "00000000-0000-4000-8000-000000000001",
          destination: { kind: "local" },
          exclude: ["logs/**", "session.lock"],
          kind: "create",
          maxBytes: 1_000_000,
          mode: "full",
          reason: "manual",
          target: { id: "instance-a", kind: "instance" },
          taskId: "00000000-0000-4000-8000-000000000011",
        }
        const second = {
          ...first,
          backupId: "00000000-0000-4000-8000-000000000002",
          destination: {
            allowPrivateNetwork: false,
            headers: {},
            kind: "s3" as const,
            objectKey: "backups/second.zip",
            uploadUrl: "https://s3.example.test/expired-upload",
          },
          taskId: "00000000-0000-4000-8000-000000000012",
        }

        const enqueued = yield* store.enqueueBackupTask(first, 100)
        assert.isFalse(enqueued.inputRefreshRequired)
        const repeated = yield* store.enqueueBackupTask(first, 200)
        assert.deepStrictEqual(repeated, enqueued)
        yield* store.enqueueBackupTask(second, 101)

        const claimed = yield* store.claimNextBackupTask(110)
        assert.strictEqual(claimed?.taskId, first.taskId)
        assert.strictEqual(claimed?.status, "running")
        assert.isTrue(
          yield* store.updateBackupTaskProgress(
            first.taskId,
            50,
            100,
            "archiving",
            "world/level.dat",
            null,
            120
          )
        )
        const inProgress = yield* store.getBackupTask(first.taskId)
        assert.strictEqual(inProgress?.phase, "archiving")
        assert.strictEqual(inProgress?.currentPath, "world/level.dat")
        assert.strictEqual(inProgress?.updatedAt, 120)
        assert.isTrue(
          yield* store.updateBackupTaskProgress(
            first.taskId,
            50,
            100,
            "archiving",
            "world/level.dat",
            null,
            125
          )
        )
        assert.strictEqual(
          (yield* store.getBackupTask(first.taskId))?.updatedAt,
          120
        )
        assert.isTrue(
          yield* store.completeBackupTask(
            first.taskId,
            {
              bytes: 100,
              checksumSha256: "a".repeat(64),
              filename: `${first.backupId}.zip`,
              warnings: [],
            },
            130
          )
        )

        const completed = yield* store.getBackupTask(first.taskId)
        assert.strictEqual(completed?.status, "succeeded")
        assert.strictEqual(completed?.bytesCompleted, 100)
        assert.strictEqual(completed?.finishedAt, 130)
        assert.deepStrictEqual(
          (yield* store.listBackupTasks(120)).map((task) => task.taskId),
          [first.taskId]
        )

        const next = yield* store.claimNextBackupTask(140)
        assert.strictEqual(next?.taskId, second.taskId)
        assert.isTrue(
          yield* store.updateBackupTaskProgress(
            second.taskId,
            50,
            100,
            "uploading",
            null,
            "00000000-0000-4000-8000-000000000003",
            145
          )
        )
        assert.strictEqual(
          (yield* store.getBackupTask(second.taskId))?.currentArtifactId,
          "00000000-0000-4000-8000-000000000003"
        )
        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(150), 1)
        const requeued = yield* store.getBackupTask(second.taskId)
        assert.strictEqual(requeued?.status, "queued")
        assert.isNull(requeued?.startedAt)
        assert.strictEqual(requeued?.bytesCompleted, 0)
        assert.isNull(requeued?.bytesTotal)
        assert.isNull(requeued?.currentArtifactId)
        assert.isNull(requeued?.result)
        assert.isTrue(requeued?.inputRefreshRequired)

        assert.isNull(yield* store.claimNextBackupTask(160))
        const refreshed = yield* store.enqueueBackupTask(
          {
            ...second,
            destination: {
              ...second.destination,
              uploadUrl: "https://s3.example.test/fresh-upload",
            },
          },
          170
        )
        assert.strictEqual(
          refreshed.input.kind === "create" &&
            refreshed.input.destination.kind === "s3" &&
            "uploadUrl" in refreshed.input.destination
            ? refreshed.input.destination.uploadUrl
            : null,
          "https://s3.example.test/fresh-upload"
        )
        assert.isFalse(refreshed.inputRefreshRequired)

        assert.strictEqual(
          (yield* store.claimNextBackupTask(180))?.taskId,
          second.taskId
        )
        assert.isTrue(yield* store.failBackupTask(second.taskId, "test", 190))

        const restore: BackupTaskInput = {
          backupId: first.backupId,
          kind: "restore",
          source: {
            bytes: 100,
            checksumSha256: "1".repeat(64),
            kind: "local",
          },
          target: first.target,
          taskId: "00000000-0000-4000-8000-000000000013",
        }
        yield* store.enqueueBackupTask(restore, 200)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(210))?.taskId,
          restore.taskId
        )
        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(220), 1)
        const interruptedRestore = yield* store.getBackupTask(restore.taskId)
        assert.strictEqual(interruptedRestore?.status, "failed")
        assert.strictEqual(interruptedRestore?.finishedAt, 220)

        const deletion: BackupTaskInput = {
          backupId: first.backupId,
          destination: { kind: "local" },
          kind: "delete",
          target: first.target,
          taskId: "00000000-0000-4000-8000-000000000015",
        }
        yield* store.enqueueBackupTask(deletion, 230)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(240))?.taskId,
          deletion.taskId
        )
        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(250), 1)
        const requeuedDeletion = yield* store.getBackupTask(deletion.taskId)
        assert.strictEqual(requeuedDeletion?.status, "queued")
        assert.isFalse(requeuedDeletion?.inputRefreshRequired)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(260))?.taskId,
          deletion.taskId
        )
        assert.isTrue(
          yield* store.completeBackupTask(
            deletion.taskId,
            { warnings: [] },
            270
          )
        )
        const completedDeletion = yield* store.getBackupTask(deletion.taskId)
        assert.strictEqual(completedDeletion?.bytesCompleted, 0)
        assert.strictEqual(completedDeletion?.status, "succeeded")
      })
    )

    it.effect("persists per-artifact delete progress", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const artifactId = "32000000-0000-4000-8000-000000000001"
        const input = {
          backupId: "32000000-0000-4000-8000-000000000002",
          destination: { artifactId, kind: "local" },
          kind: "delete",
          target: { id: "instance-a", kind: "instance" },
          taskId: "32000000-0000-4000-8000-000000000003",
        } satisfies BackupTaskInput
        yield* store.enqueueBackupTask(input, 1_000)
        yield* store.claimNextBackupTask(1_010)
        const result = {
          artifacts: [{ artifactId, error: null, status: "deleted" }],
          warnings: [],
        } satisfies BackupTaskResult

        assert.isTrue(
          yield* store.updateBackupTaskOperationProgress(
            input.taskId,
            artifactId,
            result,
            1_020
          )
        )
        const running = yield* store.getBackupTask(input.taskId)
        assert.strictEqual(running?.currentArtifactId, artifactId)
        assert.deepStrictEqual(running?.result, result)
        assert.strictEqual(running?.status, "running")
        yield* store.completeBackupTask(input.taskId, result, 1_030)
      })
    )

    it.effect("reclaims interrupted local creates without Hearth", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const local: BackupTaskInput = {
          artifactKind: "archive",
          backupId: "00000000-0000-4000-8000-000000000004",
          destination: { kind: "local" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target: { id: "instance-b", kind: "instance" },
          taskId: "00000000-0000-4000-8000-000000000014",
        }
        yield* store.enqueueBackupTask(local, 300)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(310))?.taskId,
          local.taskId
        )
        assert.isTrue(
          yield* store.updateBackupTaskProgress(
            local.taskId,
            25,
            50,
            "archiving",
            "server.properties",
            null,
            320
          )
        )

        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(330), 1)
        const requeued = yield* store.getBackupTask(local.taskId)
        assert.strictEqual(requeued?.bytesCompleted, 0)
        assert.isNull(requeued?.bytesTotal)
        assert.isFalse(requeued?.inputRefreshRequired)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(340))?.taskId,
          local.taskId
        )
        yield* store.failBackupTask(local.taskId, "test finished", 350)
      })
    )

    it.effect("reclaims credentialed S3 creates without Hearth", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const scheduled: BackupTaskInput = {
          artifactKind: "archive",
          backupId: "00000000-0000-4000-8000-000000000016",
          destination: {
            accessKeyId: "AKIDEXAMPLE",
            allowPrivateNetwork: false,
            bucket: "kiln-backups",
            endpoint: "https://s3.example.test",
            forcePathStyle: false,
            kind: "s3",
            objectKey: "backups/scheduled.zip",
            region: "us-east-1",
            secretAccessKey: "storage-secret",
          },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "scheduled",
          target: { id: "instance-c", kind: "instance" },
          taskId: "00000000-0000-4000-8000-000000000017",
        }
        yield* store.enqueueBackupTask(scheduled, 360)
        yield* store.claimNextBackupTask(370)

        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(380), 1)
        const requeued = yield* store.getBackupTask(scheduled.taskId)
        assert.isFalse(requeued?.inputRefreshRequired)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(390))?.taskId,
          scheduled.taskId
        )
        yield* store.failBackupTask(scheduled.taskId, "test finished", 400)
      })
    )

    it.effect("requeues interrupted export and prune tasks", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const exported: BackupTaskInput = {
          backupId: "40000000-0000-4000-8000-000000000001",
          kind: "export",
          repository: { kind: "local" },
          repositoryPassword: "export-secret",
          snapshotId: "abcdef12",
          target: { id: "instance-a", kind: "instance" },
          taskId: "40000000-0000-4000-8000-000000000011",
          ttlMs: 60_000,
        }
        const prune: BackupTaskInput = {
          backupId: "40000000-0000-4000-8000-000000000002",
          kind: "prune",
          repository: { kind: "local" },
          repositoryPassword: "prune-secret",
          target: { id: "instance-a", kind: "instance" },
          taskId: "40000000-0000-4000-8000-000000000012",
        }
        yield* store.enqueueBackupTask(exported, 400)
        yield* store.enqueueBackupTask(prune, 401)
        assert.strictEqual(
          (yield* store.claimNextBackupTask(410))?.taskId,
          exported.taskId
        )
        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(420), 1)
        const requeued = yield* store.getBackupTask(exported.taskId)
        assert.strictEqual(requeued?.status, "queued")
        assert.strictEqual(
          requeued?.input.kind === "export"
            ? requeued.input.repositoryPassword
            : undefined,
          "export-secret"
        )
        yield* store.claimNextBackupTask(430)
        yield* store.claimNextBackupTask(431)
        assert.strictEqual(yield* store.requeueInterruptedBackupTasks(440), 2)
        assert.strictEqual(
          (yield* store.getBackupTask(prune.taskId))?.status,
          "queued"
        )
        yield* store.failBackupTask(exported.taskId, "test finished", 450)
        yield* store.failBackupTask(prune.taskId, "test finished", 451)
      })
    )

    it.effect("scrubs repository passwords from terminal journal rows", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const input: BackupTaskInput = {
          artifactKind: "restic_snapshot",
          backupId: "41000000-0000-4000-8000-000000000001",
          destination: {
            kind: "restic",
            repository: { kind: "local" },
            repositoryPassword: "repo-secret",
          },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "incremental",
          reason: "manual",
          target: { id: "instance-a", kind: "instance" },
          taskId: "41000000-0000-4000-8000-000000000011",
        }
        yield* store.enqueueBackupTask(input, 500)
        yield* store.claimNextBackupTask(510)
        assert.isTrue(
          yield* store.completeBackupTask(
            input.taskId,
            {
              bytes: 12,
              snapshotId: "abcdef12",
              warnings: [],
            },
            520
          )
        )
        const completed = yield* store.getBackupTask(input.taskId)
        assert.strictEqual(completed?.status, "succeeded")
        assert.strictEqual(
          completed?.input.kind === "create" &&
            completed.input.destination.kind === "restic"
            ? completed.input.destination.repositoryPassword
            : "present",
          undefined
        )
      })
    )

    it.effect("scrubs S3 keys from terminal journal rows", () =>
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

    it.effect(
      "scrubs unparseable terminal journal input to an empty object",
      () =>
        Effect.gen(function* () {
          const store = yield* RelayStateStore
          const taskId = "41200000-0000-4000-8000-000000000011"
          yield* Effect.sync(() => {
            const database = new DatabaseSync(stateDatabase)
            database.exec(`
            INSERT INTO relay_backup_tasks (
              task_id, backup_id, kind, status, input_json,
              bytes_completed, created_at, updated_at
            ) VALUES (
              '${taskId}',
              '41200000-0000-4000-8000-000000000001',
              'export',
              'queued',
              'not-json {',
              0,
              560,
              560
            )
          `)
            database.close()
          })
          assert.isTrue(
            yield* store.failBackupTask(taskId, "test finished", 570)
          )
          const stored = yield* Effect.sync(() => {
            const database = new DatabaseSync(stateDatabase)
            const row = database
              .prepare(
                "SELECT input_json AS inputJson FROM relay_backup_tasks WHERE task_id = ?"
              )
              .get(taskId) as { inputJson: string } | undefined
            database.close()
            return row?.inputJson
          })
          assert.strictEqual(stored, "{}")
        })
    )

    it.effect(
      "lists backup tasks when a journal row fails schema parsing",
      () =>
        Effect.gen(function* () {
          const store = yield* RelayStateStore
          const valid: BackupTaskInput = {
            artifactKind: "restic_snapshot",
            backupId: "42000000-0000-4000-8000-000000000001",
            destination: { kind: "restic", repository: { kind: "local" } },
            exclude: [],
            kind: "create",
            maxBytes: 100,
            mode: "incremental",
            reason: "manual",
            target: { id: "instance-a", kind: "instance" },
            taskId: "42000000-0000-4000-8000-000000000011",
          }
          yield* store.enqueueBackupTask(valid, 600)
          yield* store.claimNextBackupTask(610)
          yield* store.failBackupTask(valid.taskId, "backup_too_large", 620)
          yield* Effect.sync(() => {
            const database = new DatabaseSync(stateDatabase)
            database.exec(`
            INSERT INTO relay_backup_tasks (
              task_id, backup_id, kind, status, input_json, result_json,
              bytes_completed, created_at, started_at, finished_at, updated_at
            ) VALUES (
              '42000000-0000-4000-8000-000000000012',
              '42000000-0000-4000-8000-000000000002',
              'export',
              'succeeded',
              '{"backupId":"42000000-0000-4000-8000-000000000002","expiresAt":1787136060235,"snapshotId":"abcdef12","target":{"id":"instance-a","kind":"instance"},"taskId":"42000000-0000-4000-8000-000000000012","kind":"export"}',
              NULL,
              0,
              600,
              610,
              620,
              630
            )
          `)
            database.close()
          })

          const listed = yield* store.listBackupTasks()
          const listedIds = listed.map((task) => task.taskId)
          assert.include(listedIds, valid.taskId)
          const fallback = listed.find(
            (task) => task.taskId === "42000000-0000-4000-8000-000000000012"
          )
          assert.strictEqual(fallback?.status, "failed")
          assert.strictEqual(fallback?.kind, "export")
          assert.include(
            fallback?.error ?? "",
            "journal row could not be parsed"
          )
        })
    )

    it.effect(
      "claims past a queued journal row that fails schema parsing",
      () =>
        Effect.gen(function* () {
          const store = yield* RelayStateStore
          yield* Effect.sync(() => {
            const database = new DatabaseSync(stateDatabase)
            database.exec(`
            INSERT INTO relay_backup_tasks (
              task_id, backup_id, kind, status, input_json,
              bytes_completed, created_at, updated_at
            ) VALUES (
              '44000000-0000-4000-8000-000000000011',
              '44000000-0000-4000-8000-000000000001',
              'export',
              'queued',
              '{"backupId":"44000000-0000-4000-8000-000000000001","expiresAt":1,"snapshotId":"abcdef12","target":{"id":"instance-a","kind":"instance"},"taskId":"44000000-0000-4000-8000-000000000011","kind":"export"}',
              0,
              100,
              100
            )
          `)
            database.close()
          })
          const valid: BackupTaskInput = {
            backupId: "44000000-0000-4000-8000-000000000002",
            kind: "export",
            repository: { kind: "local" },
            snapshotId: "abcdef12",
            target: { id: "instance-a", kind: "instance" },
            taskId: "44000000-0000-4000-8000-000000000012",
            ttlMs: 60_000,
          }
          yield* store.enqueueBackupTask(valid, 900)
          const claimed = yield* store.claimNextBackupTask(910)
          assert.strictEqual(claimed?.taskId, valid.taskId)
          assert.strictEqual(claimed?.status, "running")
          const corrupt = yield* store.listBackupTasks()
          const failed = corrupt.find(
            (task) => task.taskId === "44000000-0000-4000-8000-000000000011"
          )
          assert.strictEqual(failed?.status, "failed")
          yield* store.failBackupTask(valid.taskId, "test finished", 920)
        })
    )

    it.effect("prunes superseded succeeded export journal rows", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const first: BackupTaskInput = {
          backupId: "43000000-0000-4000-8000-000000000001",
          kind: "export",
          repository: { kind: "local" },
          snapshotId: "abcdef12",
          target: { id: "instance-a", kind: "instance" },
          taskId: "43000000-0000-4000-8000-000000000011",
          ttlMs: 60_000,
        }
        const second: BackupTaskInput = {
          ...first,
          taskId: "43000000-0000-4000-8000-000000000012",
        }
        yield* store.enqueueBackupTask(first, 700)
        yield* store.claimNextBackupTask(710)
        yield* store.completeBackupTask(
          first.taskId,
          {
            bytes: 12,
            checksumSha256: "b".repeat(64),
            expiresAt: 800,
            filename: "backup-43000000.zip",
            warnings: [],
          },
          720
        )
        yield* store.enqueueBackupTask(second, 730)
        const remaining = (yield* store.listBackupTasks()).filter(
          (task) => task.backupId === first.backupId && task.kind === "export"
        )
        assert.deepStrictEqual(
          remaining.map((task) => task.taskId),
          [second.taskId]
        )
        yield* store.failBackupTask(second.taskId, "test finished", 740)
      })
    )

    it.effect("durably claims and reports an instance provisioning job", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const instanceId = "a".repeat(40)
        const input = relayCreateInstanceSchema.parse({
          diskLimitBytes: 25 * 1024 ** 3,
          name: "Instant server",
          recipe: "https://example.com/brick.yml",
          start: false,
          variables: {},
        })
        const placeholder = relayInstanceSchema.parse({
          connectAddress: "relay.example.com",
          containerId: null,
          desiredState: "stopped",
          directory: instanceId,
          game: "Minecraft",
          id: instanceId,
          implementation: "Paper",
          javaVersion: "Java 21",
          limits: { diskBytes: input.diskLimitBytes, memoryBytes: 0 },
          managedByRelay: true,
          name: input.name,
          observedState: "provisioning",
          ports: [],
          provisioning: {
            attempt: 0,
            error: null,
            phase: "awaiting_claim",
          },
          resources: null,
          service: `kiln-${instanceId}`,
          shortId: instanceId.slice(0, 8),
          status: "Waiting for Hearth",
          version: "1.21.8",
        })

        const enqueued = yield* store.enqueueProvisioningJob(
          {
            idempotencyKey: "55000000-0000-4000-8000-000000000001",
            input,
            instanceId,
            placeholder,
          },
          1_000
        )
        assert.strictEqual(enqueued.status, "awaiting_claim")
        const duplicate = yield* store.enqueueProvisioningJob(
          {
            idempotencyKey: enqueued.idempotencyKey,
            input,
            instanceId: "b".repeat(40),
            placeholder: { ...placeholder, id: "b".repeat(40) },
          },
          1_001
        )
        assert.strictEqual(duplicate.instanceId, instanceId)

        assert.strictEqual(
          (yield* store.claimProvisioningJob(instanceId, 1_010))?.status,
          "queued"
        )
        const running = yield* store.claimNextProvisioningJob(1_020)
        assert.strictEqual(running?.status, "running")
        assert.strictEqual(running?.attempt, 1)
        assert.strictEqual(
          yield* store.requeueInterruptedProvisioningJobs(1_030),
          1
        )
        const failed = yield* store.getProvisioningJob(instanceId)
        assert.strictEqual(failed?.status, "failed")
        assert.strictEqual(failed?.placeholder.provisioning?.phase, "failed")
        assert.strictEqual(
          failed?.placeholder.provisioning?.failedPhase,
          "preparing"
        )
        assert.isTrue(yield* store.cancelProvisioningJob(instanceId))
        assert.isNull(yield* store.getProvisioningJob(instanceId))
      })
    )

    it.effect("keeps claiming after a queued job is cancelled", () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const firstId = "c".repeat(40)
        const secondId = "d".repeat(40)
        const input = relayCreateInstanceSchema.parse({
          diskLimitBytes: 25 * 1024 ** 3,
          name: "Queued server",
          recipe: "https://example.com/brick.yml",
          start: false,
          variables: {},
        })
        const placeholder = (instanceId: string) =>
          relayInstanceSchema.parse({
            connectAddress: "relay.example.com",
            containerId: null,
            desiredState: "stopped",
            directory: instanceId,
            game: "Minecraft",
            id: instanceId,
            implementation: "Paper",
            javaVersion: "Java 21",
            limits: { diskBytes: input.diskLimitBytes, memoryBytes: 0 },
            managedByRelay: true,
            name: input.name,
            observedState: "provisioning",
            ports: [],
            provisioning: {
              attempt: 0,
              error: null,
              phase: "awaiting_claim",
            },
            resources: null,
            service: `kiln-${instanceId}`,
            shortId: instanceId.slice(0, 8),
            status: "Waiting for Hearth",
            version: "1.21.8",
          })
        yield* store.enqueueProvisioningJob(
          {
            idempotencyKey: "55000000-0000-4000-8000-000000000002",
            input,
            instanceId: firstId,
            placeholder: placeholder(firstId),
          },
          2_000
        )
        yield* store.enqueueProvisioningJob(
          {
            idempotencyKey: "55000000-0000-4000-8000-000000000003",
            input,
            instanceId: secondId,
            placeholder: placeholder(secondId),
          },
          2_001
        )
        yield* store.claimProvisioningJob(firstId, 2_010)
        yield* store.claimProvisioningJob(secondId, 2_011)

        const [cancelled, claimed] = yield* Effect.all(
          [
            store.cancelProvisioningJob(firstId),
            store.claimNextProvisioningJob(2_020),
          ],
          { concurrency: "unbounded" }
        )
        const running = cancelled
          ? claimed
          : claimed?.instanceId === firstId
            ? yield* store.claimNextProvisioningJob(2_021)
            : claimed
        if (!running) {
          return yield* Effect.die(
            "The remaining provisioning job was not claimed"
          )
        }
        assert.strictEqual(running.instanceId, secondId)
        assert.strictEqual(running.status, "running")
        yield* store.failProvisioningJob(
          secondId,
          "test finished",
          running.placeholder,
          2_030
        )
        yield* store.cancelProvisioningJob(secondId)
        yield* store.cancelProvisioningJob(firstId)
      })
    )
  })
})

describe("backup task secret scrubbing", () => {
  it("omits secrets and replaces unparseable JSON with an empty object", () => {
    assert.strictEqual(scrubBackupTaskInputJson("not-json {"), "{}")
    assert.deepStrictEqual(
      JSON.parse(
        scrubBackupTaskInputJson(
          JSON.stringify({
            accessKeyId: "AKIAEXAMPLE",
            keep: "yes",
            nested: { repositoryPassword: "repo-secret", value: 1 },
            secretAccessKey: "s3-secret",
          })
        )
      ),
      { keep: "yes", nested: { value: 1 } }
    )
  })
})
