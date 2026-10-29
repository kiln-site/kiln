import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { createAppRecordEffect } from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  createResourceBackupHandler,
  restoreResourceBackupHandler,
} from "@/server/backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertGrant,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

// The Relay is the only network boundary these handlers cross: it says which
// Apps use a volume and is offline for everything else, so dispatch never
// succeeds.
const relay = vi.hoisted(() => ({
  protectionReady: true,
  volumeUsers: [] as Array<string>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation !== "relay.volumes.read") throw new Error("Relay is offline")
    return {
      measuring: false,
      protection: relay.protectionReady
        ? { ready: true, reason: null }
        : { ready: false, reason: "waiting for Hearth B to connect" },
      uncovered: [],
      volumes: [
        {
          createdAt: null,
          dockerName: "kiln-c0ffee00-media",
          id: kilnVolumeId,
          kind: "kiln",
          mountpoint: null,
          mounts: [],
          name: "media",
          owner: null,
          sizeBytes: null,
          users: relay.volumeUsers.map((appId) => ({
            appId,
            configured: true,
            mounted: false,
          })),
        },
      ],
    }
  },
}))

// App configurations are kept encrypted.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const kilnVolumeId = "c".repeat(40)

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

// Permissions on the whole Relay: App permissions are granted there, for
// every App on it.
const grant = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      userId: user.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
    return id
  })

// A finished archive of a Kiln volume, kept on the Relay's disk.
const seedVolumeBackup = Effect.gen(function* () {
  const backupId = randomUUID()
  const archive = {
    bytes: 1024,
    checksum_sha256: "0".repeat(64),
    filename: "media.tar.gz",
  }
  yield* insertBackup(backupId, {
    ...archive,
    artifact_kind: "tar_archive",
    relay_id: relayId,
    target_id: kilnVolumeId,
    target_kind: "volume",
  })
  yield* insertRows("backup_artifact", {
    ...archive,
    backup_id: backupId,
    created_at: at,
    destination_key: "local",
    id: randomUUID(),
    status: "available",
    updated_at: at,
  })
  yield* insertRows("backup_task", {
    backup_id: backupId,
    created_at: at,
    id: randomUUID(),
    status: "succeeded",
    task_kind: "create",
    updated_at: at,
  })
  return backupId
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  relay.volumeUsers = [appId]
  relay.protectionReady = true
})

const rejection = (run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: (error) => error as Error }).pipe(
    Effect.flip,
    Effect.map((error) => error.message)
  )

const count = (table: string) =>
  selectRows(table).pipe(Effect.map((rows) => rows.length))

const backups = selectRows<{
  artifact_kind: string
  consistency: string | null
  target_id: string
  target_kind: string
}>("backup")

const addPermission = (access: string, permission: AccessPermission) =>
  insertRows("access_selection", {
    access_id: access,
    selection_kind: "permission",
    selection_key: permission,
  })

const restoreTasks = selectRows<{ task_kind: string }>("backup_task").pipe(
  Effect.map((tasks) => tasks.filter((task) => task.task_kind === "restore"))
)

describeMysql("App and volume backup authorization", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "an App's backup takes permission to read its files, not the Relay's backup permissions",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* grant(["backup.create", "backup.download", "backup.read"])

          for (const target of [
            { id: appId, kind: "app" as const },
            { id: `${appId}/pgdata`, kind: "volume" as const },
          ]) {
            const message = yield* rejection(() =>
              createResourceBackupHandler(user, {
                name: "Before the upgrade",
                relayId,
                target,
              })
            )
            assert.include(message, "do not have permission to back up")
          }
          assert.strictEqual(yield* count("backup"), 0)
        })
    )

    it.effect(
      "someone who can read an App's files backs it up, as a tar archive taken live",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* createAppRecordEffect({
            appId,
            createdBy: "someone-else",
            name: "Website",
            relayId,
          })
          yield* grant(["app.files.read"])

          const created = yield* Effect.promise(() =>
            createResourceBackupHandler(user, {
              name: "Before the upgrade",
              relayId,
              target: { id: appId, kind: "app" },
            })
          )

          assert.strictEqual(created.backup.targetKind, "app")
          assert.deepStrictEqual(yield* backups, [
            {
              ...(yield* backups)[0]!,
              artifact_kind: "tar_archive",
              consistency: "live",
              target_id: appId,
              target_kind: "app",
            },
          ])
        })
    )

    it.effect(
      "a stopped backup takes permission to manage every App it stops",
      () =>
        Effect.gen(function* () {
          yield* seed
          const access = yield* grant(["backup.create"])
          const stopped = () =>
            createResourceBackupHandler(user, {
              consistency: "stopped",
              name: "Media",
              relayId,
              target: { id: kilnVolumeId, kind: "volume" },
            })

          const message = yield* rejection(stopped)
          assert.include(message, "permission to manage each")
          assert.strictEqual(yield* count("backup"), 0)

          yield* addPermission(access, "app.manage")
          yield* Effect.promise(stopped)
          assert.strictEqual((yield* backups)[0]?.consistency, "stopped")
        })
    )

    it.effect(
      "a volume isn't restored while the Relay can't tell which Apps use it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const backupId = yield* seedVolumeBackup
          yield* grant(["backup.restore", "app.files.write"])
          relay.protectionReady = false

          const message = yield* rejection(() =>
            restoreResourceBackupHandler(user, {
              backupId,
              safetyBackup: false,
            })
          )

          assert.include(message, "doesn't know yet which Apps use this volume")
          assert.deepStrictEqual(yield* restoreTasks, [])
        })
    )

    it.effect(
      "a Kiln volume's backup takes the Relay's backup permission, not App permissions",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* grant(["app.files.read", "app.files.write", "app.manage"])

          const message = yield* rejection(() =>
            createResourceBackupHandler(user, {
              name: "Media",
              relayId,
              target: { id: kilnVolumeId, kind: "volume" },
            })
          )

          assert.include(message, "do not have permission to back up")
          assert.strictEqual(yield* count("backup"), 0)
        })
    )

    it.effect(
      "restoring a volume takes permission to change the files of every App that uses it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const backupId = yield* seedVolumeBackup
          const access = yield* grant(["backup.restore"])

          const message = yield* rejection(() =>
            restoreResourceBackupHandler(user, {
              backupId,
              safetyBackup: false,
            })
          )
          assert.include(message, "change each App's files")
          assert.deepStrictEqual(yield* restoreTasks, [])

          // With it, the restore is queued.
          yield* addPermission(access, "app.files.write")
          yield* Effect.promise(() =>
            restoreResourceBackupHandler(user, {
              backupId,
              safetyBackup: false,
            })
          )
          assert.strictEqual((yield* restoreTasks).length, 1)
        })
    )
  })
})
