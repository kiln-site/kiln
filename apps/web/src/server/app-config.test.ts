import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import type { AppMount } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  createAppRecordEffect,
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  getAppConfigHandler,
  updateAppConfigHandler,
} from "@/server/app-access"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const target = { appId, relayId }

const sessionUser = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

// App permissions are granted on a Relay, for every app on it.
const grant = (userId: string, permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      state: "active",
      userId,
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

const fileMount: AppMount = {
  id: "conffile01",
  readOnly: true,
  service: null,
  source: { content: "secret = hunter2\n", type: "file" },
  target: "/etc/app.conf",
}

const hostMount = (path: string, readOnly: boolean): AppMount => ({
  id: "nodepath01",
  readOnly,
  service: null,
  source: { path, type: "host" },
  target: "/shared",
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  for (const id of ["owner", "manager", "host-manager", "viewer"]) {
    yield* insertUser(id)
  }
  yield* insertRelay(relayId, { created_by: "owner" })
  yield* grant("manager", ["app.read", "app.manage"])
  yield* grant("host-manager", ["app.read", "app.manage", "relay.files.write"])
  yield* grant("viewer", ["app.read"])
  yield* createAppRecordEffect({
    appId,
    createdBy: "manager",
    name: "Website",
    relayId,
  })
  yield* updateAppConfigEffect(relayId, appId, (config) => ({
    ...config,
    environment: "TOKEN=abc",
    mounts: [fileMount, hostMount("/srv/shared", true)],
  }))
})

const saved = Effect.map(
  loadAppConfigEffect(relayId, appId),
  (app) => app!.config
)

const update = (userId: string, config: unknown) =>
  Effect.promise(() =>
    updateAppConfigHandler(sessionUser(userId), { ...target, config }).then(
      () => null,
      (error: unknown) => error
    )
  )

describeMysql("app config", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "shows the files it mounts and its environment only to those who can change it",
      () =>
        Effect.gen(function* () {
          yield* seed

          const viewed = yield* Effect.promise(() =>
            getAppConfigHandler(sessionUser("viewer"), target)
          )
          assert.strictEqual(viewed.environmentHidden, true)
          assert.strictEqual(viewed.config.environment, "")
          assert.deepStrictEqual(viewed.config.mounts[0]?.source, {
            content: "",
            type: "file",
          })

          const managed = yield* Effect.promise(() =>
            getAppConfigHandler(sessionUser("manager"), target)
          )
          assert.strictEqual(managed.config.environment, "TOKEN=abc")
          assert.deepStrictEqual(managed.config.mounts[0], fileMount)
        })
    )

    it.effect("keeps its mounts through an edit that leaves them out", () =>
      Effect.gen(function* () {
        yield* seed

        assert.isNull(yield* update("manager", { image: "nginx:alpine" }))

        const config = yield* saved
        assert.strictEqual(config.image, "nginx:alpine")
        assert.deepStrictEqual(config.mounts, [
          fileMount,
          hostMount("/srv/shared", true),
        ])
      })
    )

    it.effect(
      "takes permission to edit the node's files to mount a path on it anew",
      () =>
        Effect.gen(function* () {
          yield* seed

          // The path it already mounts, as it mounts it, needs nothing more.
          assert.isNull(
            yield* update("manager", {
              mounts: [fileMount, hostMount("/srv/shared", true)],
            })
          )
          // Another path, or the same one made writable, does.
          for (const mount of [
            hostMount("/var/run/docker.sock", true),
            hostMount("/srv/shared", false),
          ]) {
            assert.isNotNull(
              yield* update("manager", { mounts: [fileMount, mount] })
            )
          }
          assert.deepStrictEqual((yield* saved).mounts, [
            fileMount,
            hostMount("/srv/shared", true),
          ])

          assert.isNull(
            yield* update("host-manager", {
              mounts: [hostMount("/srv/shared", false)],
            })
          )
          assert.deepStrictEqual((yield* saved).mounts, [
            hostMount("/srv/shared", false),
          ])
        })
    )

    it.effect("refuses a mount whose ID would name a path", () =>
      Effect.gen(function* () {
        yield* seed

        const error = yield* update("manager", {
          mounts: [{ ...fileMount, id: "../../network" }],
        })

        assert.isNotNull(error)
        assert.deepStrictEqual((yield* saved).mounts[0], fileMount)
      })
    )
  })
})
