import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  createAppBackupsHandler,
  getAppBackupsHandler,
  listUnfinishedRestoresHandler,
  resolveUnfinishedRestoreHandler,
  settleAppBackup,
} from "@/server/app-backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, selectRows } from "@/test/seed"

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
const otherAppId = "b".repeat(12)
const kilnVolumeId = "c".repeat(40)
const goneVolumeId = "d".repeat(40)
const taskId = "0b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e"

// The Relay is the only network boundary: it lists volumes and unfinished
// restores, and finishes or abandons one; dispatching a backup fails, as
// to a Relay that's offline.
const relay = vi.hoisted(() => ({
  dispatched: [] as Array<{ batch?: { id: string; size: number } }>,
  // The Apps that use the Kiln volume.
  kilnUsers: [] as Array<string>,
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
    // It takes whichever volumes a configuration says it mounts.
    if (operation === "app.volumes.write") return {}
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
      filesAvailable: false,
      measuring: false,
      protection: { ready: true, reason: null },
      uncovered: [],
      volumes: [
        volume(`${appId}/pgdata`, { appId, volume: "pgdata" }, [appId]),
        volume(kilnVolumeId, null, relay.kilnUsers),
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
  // Another App mounts the Kiln volume.
  relay.kilnUsers = [otherAppId]
  relay.resolved = []
  relay.unfinished = []
})

// Backing up the App as its server function does: settled, then run.
const backUp = Effect.promise(async () =>
  createAppBackupsHandler(
    user,
    await settleAppBackup(user, {
      appId,
      consistency: "live" as const,
      name: "Before the upgrade",
      relayId,
      storageIds: [null],
    })
  )
)

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
        yield* grant(["instance.files.read"])

        yield* backUp

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

    // What an App keeps is on the volumes it mounts, so its backup takes
    // each of them, one another App uses too, and none is made that would
    // leave one out.
    it.effect(
      "takes every volume the App uses, and none of them when one is missing",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.kilnUsers = [appId, otherAppId]
          const mount = (id: string, volumeId: string, target: string) => ({
            id,
            readOnly: false,
            service: null,
            source: { type: "volume" as const, volumeId },
            target,
          })
          yield* createAppRecordEffect({
            appId,
            createdBy: "someone-else",
            mounts: [mount("sharedmount1", kilnVolumeId, "/media")],
            name: "Website",
            relayId,
          })
          const access = yield* grant(["app.read", "instance.files.read"])

          yield* backUp

          const taken = () =>
            Effect.map(
              selectRows<{ target_id: string; target_kind: string }>("backup"),
              (rows) =>
                rows.map(({ target_id, target_kind }) => [
                  target_kind,
                  target_id,
                ])
            )
          assert.sameDeepMembers(yield* taken(), [
            ["app", appId],
            ["volume", `${appId}/pgdata`],
            ["volume", kilnVolumeId],
          ])
          // The volume's backups are its own to see: someone who may only
          // see the App's is shown that the volume is taken, not its backups.
          const shown = () =>
            Effect.map(
              Effect.promise(() =>
                getAppBackupsHandler(user, { appId, relayId })
              ),
              ({ targets }) =>
                targets.map((target) => [
                  target.id,
                  target.readable,
                  target.latest !== null,
                ])
            )
          assert.sameDeepMembers(yield* shown(), [
            [appId, true, true],
            [`${appId}/pgdata`, true, true],
            [kilnVolumeId, false, false],
          ])
          yield* insertRows("access_selection", {
            access_id: access,
            selection_kind: "permission",
            selection_key: "backup.read",
          })
          assert.deepInclude(yield* shown(), [kilnVolumeId, true, true])

          // A volume its configuration mounts that its Relay doesn't have.
          yield* updateAppConfigEffect(relayId, appId, (config) => ({
            ...config,
            mounts: [
              ...config.mounts,
              mount("gonemount001", goneVolumeId, "/uploads"),
            ],
          }))
          const before = (yield* taken()).length
          assert.include(
            yield* rejection(() => Effect.runPromise(backUp)),
            "A volume this App mounts is missing"
          )
          assert.lengthOf(yield* taken(), before)
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
            selection_key: "instance.files.write",
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
