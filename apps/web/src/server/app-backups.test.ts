import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { createAppRecordEffect } from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  createAppBackupsHandler,
  listUnfinishedRestoresHandler,
  resolveUnfinishedRestoreHandler,
} from "@/server/app-backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, selectRows } from "@/test/seed"

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const otherAppId = "b".repeat(40)
const kilnVolumeId = "c".repeat(40)
const taskId = "0b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e"

// The Relay is the only network boundary: it lists volumes and unfinished
// restores, and finishes or abandons one; dispatching a backup fails, as
// to a Relay that's offline.
const relay = vi.hoisted(() => ({
  dispatched: [] as Array<{ batch?: { id: string; size: number } }>,
  resolved: [] as Array<string>,
  unfinished: [] as Array<{ kind: "app" | "volume"; id: string }>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { taskId?: string }
  ) => {
    if (operation === "backup.restore.unfinished") {
      return relay.unfinished.map((target) => ({
        phase: "installing",
        target,
        taskId,
      }))
    }
    if (operation === "backup.restore.resolve") {
      relay.resolved.push(payload.taskId ?? "")
      relay.unfinished = []
      return { resolved: true, taskId: payload.taskId }
    }
    if (operation !== "relay.volumes.read") throw new Error("Relay is offline")
    const volume = (
      id: string,
      owner: { appId: string; volume: string } | null,
      users: ReadonlyArray<string>
    ) => ({
      createdAt: null,
      dockerName: `docker-${id.replace("/", "-")}`,
      id,
      kind: owner ? "app" : "kiln",
      mountpoint: null,
      mounts: [],
      name: owner?.volume ?? "media",
      owner,
      sizeBytes: null,
      users: users.map((user) => ({
        appId: user,
        configured: true,
        mounted: false,
      })),
    })
    return {
      measuring: false,
      protection: { ready: true, reason: null },
      uncovered: [],
      volumes: [
        volume(`${appId}/pgdata`, { appId, volume: "pgdata" }, [appId]),
        // Another App mounts the Kiln volume.
        volume(kilnVolumeId, null, [otherAppId]),
      ],
    }
  },
}))
vi.mock("@/lib/relay-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-registry")>()),
  activeRelay: async () => ({ enabled: true, id: relayId, name: "Relay" }),
  listPersistedRelays: async () => [
    { enabled: true, id: relayId, name: "Relay" },
  ],
}))
vi.mock("@/lib/backup-reconciliation", () => ({
  dispatchBackupTask: async (
    _relay: unknown,
    input: { batch?: { id: string; size: number } }
  ) => {
    relay.dispatched.push(input)
    throw new Error("Relay is offline")
  },
  reconcileRelayBackups: async () => undefined,
}))

// App configurations are kept encrypted.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const user: AuthenticatedUser = {
  email: "member@example.test",
  emailVerified: true,
  emailVerifiedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  id: "member",
  isDevelopmentBypass: false,
  name: "Member",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

// Permissions on the whole Relay, where App permissions are granted.
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

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  relay.dispatched = []
  relay.resolved = []
  relay.unfinished = []
})

const rejection = (run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: (error) => error as Error }).pipe(
    Effect.flip,
    Effect.map((error) => error.message)
  )

describeMysql("App backups", () => {
  layer(TestDatabase)((it) => {
    it.effect("backs up an App's folder and its own volumes as one batch", () =>
      Effect.gen(function* () {
        yield* seed
        yield* createAppRecordEffect({
          appId,
          createdBy: "someone-else",
          name: "Website",
          relayId,
        })
        yield* grant(["app.files.read"])

        yield* Effect.promise(() =>
          createAppBackupsHandler(user, {
            appId,
            consistency: "live",
            name: "Before the upgrade",
            relayId,
          })
        )

        const backups = yield* selectRows<{
          batch_id: string | null
          target_id: string
          target_kind: string
        }>("backup")
        assert.sameDeepMembers(
          backups.map(({ target_id, target_kind }) => [target_kind, target_id]),
          [
            ["app", appId],
            ["volume", `${appId}/pgdata`],
          ]
        )
        assert.strictEqual(new Set(backups.map((row) => row.batch_id)).size, 1)
        assert.isNotNull(backups[0]?.batch_id)
      })
    )

    it.effect(
      "finishes an unfinished restore only for someone who may change every App that uses its volume",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.unfinished = [{ id: kilnVolumeId, kind: "volume" }]
          const access = yield* grant(["backup.read", "backup.restore"])

          const message = yield* rejection(() =>
            resolveUnfinishedRestoreHandler(user, {
              action: "finish",
              relayId,
              taskId,
            })
          )
          assert.include(message, "change each App's files")
          assert.deepStrictEqual(relay.resolved, [])
          assert.lengthOf(
            yield* Effect.promise(() => listUnfinishedRestoresHandler(user)),
            1
          )

          yield* insertRows("access_selection", {
            access_id: access,
            selection_kind: "permission",
            selection_key: "app.files.write",
          })
          yield* Effect.promise(() =>
            resolveUnfinishedRestoreHandler(user, {
              action: "finish",
              relayId,
              taskId,
            })
          )
          assert.deepStrictEqual(relay.resolved, [taskId])
        })
    )
  })
})
