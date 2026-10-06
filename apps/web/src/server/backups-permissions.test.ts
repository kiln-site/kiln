import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  builtinTailscaleBrick,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  copyBackupToDestinationHandler,
  createInstanceBackupHandler,
  restoreInstanceBackupHandler,
} from "@/server/backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertGrant,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

// The Relay is the only network boundary these handlers cross: it answers
// snapshots and is offline for everything else, so dispatch never succeeds.
const relay = vi.hoisted(() => ({ snapshot: undefined as unknown }))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation === "relay.snapshot") return relay.snapshot
    throw new Error("Relay is offline")
  },
}))
// Queued copies are streamed to S3 by a background worker; these tests stop
// at the queue.
vi.mock("@/lib/backup-copy", () => ({
  scheduleBackupCopyProcessing: () => undefined,
}))

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const relayId = "r".repeat(43)
const instanceId = "a".repeat(40)
const siblingId = "b".repeat(40)

const user: AuthenticatedUser = {
  email: "member@example.test",
  emailVerified: true,
  emailVerifiedAt: new Date(at).toISOString(),
  id: "member",
  isDevelopmentBypass: false,
  name: "Member",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

const instance = relayInstanceSchema.parse({
  id: instanceId,
  shortId: instanceId.slice(0, 8),
  name: "Survival",
  service: "server",
  directory: "/data/server",
  containerId: "container",
  desiredState: "stopped",
  observedState: "stopped",
  status: "stopped",
  game: "Minecraft",
  implementation: "paper",
  javaVersion: "21",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  brickSource: builtinTailscaleBrick.source,
  variables: {},
  limits: { diskBytes: 1024 ** 3, memoryBytes: 1024 ** 3 },
})

relay.snapshot = relaySnapshotSchema.parse({
  instances: [instance],
  node: {
    id: relayId,
    name: "Relay",
    version: "test",
    platform: "linux",
    arch: "arm64",
    connectedAt: new Date(at).toISOString(),
    cpu: { cores: 4, loadPercent: 0 },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0 },
    storage: { totalBytes: 20 * 1024 ** 3, usedBytes: 0 },
    docker: { available: true, version: "test" },
  },
})

const grant = (
  resourceId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      userId: user.id,
      relayId,
      resourceType: "instance",
      resourceId,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

// A finished archive of the instance, kept on the Relay's disk.
const archive = {
  filename: "survival.zip",
  bytes: 1024,
  checksum_sha256: "0".repeat(64),
}
const seedBackup = Effect.gen(function* () {
  const backupId = randomUUID()
  yield* insertBackup(backupId, {
    relay_id: relayId,
    target_id: instanceId,
    ...archive,
  })
  yield* insertRows("backup_artifact", {
    id: randomUUID(),
    backup_id: backupId,
    destination_key: "local",
    status: "available",
    ...archive,
    created_at: at,
    updated_at: at,
  })
  yield* insertRows("backup_task", {
    id: randomUUID(),
    backup_id: backupId,
    task_kind: "create",
    status: "succeeded",
    created_at: at,
    updated_at: at,
  })
  return backupId
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  const teamStorageId = randomUUID()
  const personalStorageId = randomUUID()
  yield* insertBackupStorage(teamStorageId)
  yield* insertBackupStorage(personalStorageId, { owner_user_id: user.id })
  return { personalStorageId, teamStorageId }
})

const rejection = (run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: (error) => error as Error }).pipe(
    Effect.flip,
    Effect.map((error) => error.message)
  )

const count = (table: string) =>
  selectRows(table).pipe(Effect.map((rows) => rows.length))

const restoreTasks = selectRows<{ task_kind: string }>("backup_task").pipe(
  Effect.map((tasks) => tasks.filter((task) => task.task_kind === "restore"))
)

describeMysql("backup authorization", () => {
  layer(TestDatabase)((it) => {
    it.effect("copying a backup needs download, not create", () =>
      Effect.gen(function* () {
        const { teamStorageId } = yield* seed
        const backupId = yield* seedBackup
        yield* grant(instanceId, ["backup.create", "backup.read"])

        const message = yield* rejection(() =>
          copyBackupToDestinationHandler(user, {
            backupId,
            storageId: teamStorageId,
          })
        )

        assert.include(message, "permission to copy")
        assert.strictEqual(yield* count("backup_copy_task"), 0)
      })
    )

    it.effect("a download grant on the backup's server queues a copy", () =>
      Effect.gen(function* () {
        const { teamStorageId } = yield* seed
        const backupId = yield* seedBackup
        yield* grant(instanceId, ["backup.download"])

        const result = yield* Effect.promise(() =>
          copyBackupToDestinationHandler(user, {
            backupId,
            storageId: teamStorageId,
          })
        )

        const tasks = yield* selectRows<{
          id: string
          backup_id: string
          requested_by: string
        }>("backup_copy_task")
        assert.deepStrictEqual(
          tasks.map((task) => [task.id, task.backup_id, task.requested_by]),
          [[result.taskId, backupId, user.id]]
        )
      })
    )

    it.effect("a download grant on another server cannot copy the backup", () =>
      Effect.gen(function* () {
        const { teamStorageId } = yield* seed
        const backupId = yield* seedBackup
        yield* grant(siblingId, ["backup.download"])

        const message = yield* rejection(() =>
          copyBackupToDestinationHandler(user, {
            backupId,
            storageId: teamStorageId,
          })
        )

        assert.include(message, "permission to copy")
        assert.strictEqual(yield* count("backup_copy_task"), 0)
      })
    )

    it.effect("creating into personal storage also needs download", () =>
      Effect.gen(function* () {
        const { personalStorageId } = yield* seed
        yield* grant(instanceId, ["backup.create"])

        const message = yield* rejection(() =>
          createInstanceBackupHandler(user, {
            instanceId,
            name: "Before update",
            relayId,
            storageIds: [null, personalStorageId],
          })
        )

        assert.include(message, "do not have permission")
        assert.strictEqual(yield* count("backup"), 0)
      })
    )

    it.effect("create and download together create into personal storage", () =>
      Effect.gen(function* () {
        const { personalStorageId } = yield* seed
        yield* grant(instanceId, ["backup.create", "backup.download"])

        const { backup } = yield* Effect.promise(() =>
          createInstanceBackupHandler(user, {
            instanceId,
            mode: "full",
            name: "Before update",
            relayId,
            storageIds: [null, personalStorageId],
          })
        )

        const backups = yield* selectRows<{ id: string; target_id: string }>(
          "backup"
        )
        assert.deepStrictEqual(
          backups.map((row) => [row.id, row.target_id]),
          [[backup.id, instanceId]]
        )
        const artifacts = yield* selectRows<{ storage_id: string | null }>(
          "backup_artifact"
        )
        assert.sameMembers(
          artifacts.map((artifact) => artifact.storage_id),
          [null, personalStorageId]
        )
      })
    )

    it.effect(
      "a safety backup into personal storage needs download before restoring",
      () =>
        Effect.gen(function* () {
          const { personalStorageId } = yield* seed
          const backupId = yield* seedBackup
          yield* insertRows("backup_policy", {
            relay_id: relayId,
            target_kind: "instance",
            target_id: instanceId,
            storage_id: personalStorageId,
            exclude_patterns: "[]",
            created_at: at,
            updated_at: at,
          })
          yield* grant(instanceId, ["backup.restore", "backup.create"])

          const message = yield* rejection(() =>
            restoreInstanceBackupHandler(user, {
              backupId,
              safetyBackup: true,
            })
          )

          assert.include(message, "do not have permission")
          assert.strictEqual(yield* count("backup"), 1)
          assert.deepStrictEqual(yield* restoreTasks, [])
        })
    )

    it.effect("a safety backup needs create before restoring", () =>
      Effect.gen(function* () {
        yield* seed
        const backupId = yield* seedBackup
        yield* grant(instanceId, ["backup.restore"])

        const message = yield* rejection(() =>
          restoreInstanceBackupHandler(user, { backupId, safetyBackup: true })
        )

        assert.include(message, "do not have permission")
        assert.strictEqual(yield* count("backup"), 1)
        assert.deepStrictEqual(yield* restoreTasks, [])
      })
    )

    it.effect("restore queues the safety backup ahead of the restore", () =>
      Effect.gen(function* () {
        const { personalStorageId } = yield* seed
        const backupId = yield* seedBackup
        yield* insertRows("backup_policy", {
          relay_id: relayId,
          target_kind: "instance",
          target_id: instanceId,
          storage_id: personalStorageId,
          exclude_patterns: "[]",
          created_at: at,
          updated_at: at,
        })
        yield* grant(instanceId, [
          "backup.restore",
          "backup.create",
          "backup.download",
        ])

        const result = yield* Effect.promise(() =>
          restoreInstanceBackupHandler(user, { backupId, safetyBackup: true })
        )

        const tasks = yield* selectRows<{
          id: string
          backup_id: string
          task_kind: string
          depends_on_task_id: string | null
        }>("backup_task")
        const restore = tasks.find((task) => task.id === result.restoreTaskId)
        const safety = tasks.find(
          (task) => task.backup_id === result.safetyBackupId
        )
        assert.strictEqual(restore?.backup_id, backupId)
        assert.strictEqual(restore?.task_kind, "restore")
        assert.strictEqual(safety?.task_kind, "create")
        assert.strictEqual(restore?.depends_on_task_id, safety?.id)
      })
    )
  })
})
