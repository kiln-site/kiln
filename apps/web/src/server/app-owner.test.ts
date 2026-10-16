import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  getAppOwnerHandler,
  getAppOwnerMinecraftProfileIdHandler,
} from "@/server/app-access"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const otherRelayId = "o".repeat(43)
const appId = "a".repeat(40)
const orphanedId = "b".repeat(40)
const target = (id: string) => ({ appId: id, relayId })

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
const grant = (
  userId: string,
  grantRelayId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId: grantRelayId,
      resourceId: grantRelayId,
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

const insertApp = (id: string, createdBy: string) =>
  insertRows("app", {
    app_id: id,
    relay_id: relayId,
    name: id.slice(0, 8),
    config_ciphertext: "unused",
    created_by: createdBy,
    created_at: 0,
    updated_at: 0,
  })

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("owner", { name: "Steve" })
  for (const id of ["manager", "viewer", "stranger", "relay-only", "elsewhere"])
    yield* insertUser(id)
  yield* insertRelay(relayId)
  yield* insertRelay(otherRelayId)
  yield* insertApp(appId, "owner")
  // Its creator's account is gone.
  yield* insertApp(orphanedId, "deleted-user")
  yield* grant("manager", relayId, ["app.read", "access.read"])
  yield* grant("viewer", relayId, ["app.read"])
  // Relay access that doesn't reach its apps.
  yield* grant("relay-only", relayId, ["relay.read", "access.read"])
  yield* grant("elsewhere", otherRelayId, ["app.read", "access.read"])
})

const refusal = (promise: Promise<unknown>) =>
  Effect.promise(() =>
    promise.then(
      () => null,
      (error: unknown) => error
    )
  )

const ownerFor = (userId: string, id = appId) =>
  Effect.promise(() => getAppOwnerHandler(sessionUser(userId), target(id)))

describeMysql("app owner", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "someone who can read the Relay's people sees the owner's email",
      () =>
        Effect.gen(function* () {
          yield* seed

          const owner = yield* ownerFor("manager")

          assert.deepStrictEqual(owner, {
            email: "owner@example.test",
            name: "Steve",
          })
        })
    )

    it.effect(
      "someone who can only read apps gets the owner's name alone",
      () =>
        Effect.gen(function* () {
          yield* seed

          const owner = yield* ownerFor("viewer")

          assert.deepStrictEqual(owner, { email: null, name: "Steve" })
        })
    )

    it.effect("someone who can't read the Relay's apps learns nothing", () =>
      Effect.gen(function* () {
        yield* seed

        for (const userId of ["stranger", "relay-only", "elsewhere"]) {
          const user = sessionUser(userId)
          assert.instanceOf(
            yield* refusal(getAppOwnerHandler(user, target(appId))),
            Error
          )
          assert.instanceOf(
            yield* refusal(
              getAppOwnerMinecraftProfileIdHandler(user, target(appId))
            ),
            Error
          )
        }
      })
    )

    it.effect("an app on another Relay isn't found through this one", () =>
      Effect.gen(function* () {
        yield* seed

        assert.instanceOf(
          yield* refusal(
            getAppOwnerHandler(sessionUser("elsewhere"), {
              appId,
              relayId: otherRelayId,
            })
          ),
          Error
        )
      })
    )

    it.effect("an app whose creator is gone has no owner", () =>
      Effect.gen(function* () {
        yield* seed

        const owner = yield* ownerFor("viewer", orphanedId)

        assert.isNull(owner)
      })
    )
  })
})
