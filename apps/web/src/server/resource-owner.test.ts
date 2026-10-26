import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  getResourceOwnerHandler,
} from "@/server/resource-access.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const ownedId = "a".repeat(40)
const unownedId = "b".repeat(40)
const scope = (resourceId: string) =>
  ({ relayId, resourceId, resourceType: "instance" }) as const

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

const grant = (
  userId: string,
  resourceId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId,
      resourceType: resourceId === relayId ? "relay" : "instance",
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

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("owner", { name: "Steve" })
  for (const id of [
    "manager",
    "player",
    "stranger",
    "relay-viewer",
    "relay-player",
  ])
    yield* insertUser(id)
  yield* insertRelay(relayId)
  yield* insertInstance(relayId, ownedId, { owner_id: "owner" })
  yield* insertInstance(relayId, unownedId)
  yield* grant("manager", ownedId, ["instance.read", "access.read"])
  yield* grant("player", ownedId, ["instance.read"])
  yield* grant("player", unownedId, ["instance.read"])
  // Relay access reaches a server only through server permissions.
  yield* grant("relay-viewer", relayId, ["relay.read"])
  yield* grant("relay-player", relayId, ["instance.read"])
})

const refusal = (promise: Promise<unknown>) =>
  Effect.promise(() =>
    promise.then(
      () => null,
      (error: unknown) => error
    )
  )

const ownerFor = (userId: string, resourceId: string) =>
  Effect.promise(() =>
    getResourceOwnerHandler(sessionUser(userId), scope(resourceId))
  )

describeMysql("resource owner", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "someone who can read the server's people sees the owner's email",
      () =>
        Effect.gen(function* () {
          yield* seed

          const owner = yield* ownerFor("manager", ownedId)

          assert.deepStrictEqual(owner, {
            email: "owner@example.test",
            name: "Steve",
            userId: "owner",
          })
        })
    )

    it.effect(
      "someone who can only see the server gets the owner's name alone",
      () =>
        Effect.gen(function* () {
          yield* seed

          const owner = yield* ownerFor("player", ownedId)

          assert.deepStrictEqual(owner, {
            email: null,
            name: "Steve",
            userId: "owner",
          })
        })
    )

    it.effect("someone without access to the server learns nothing", () =>
      Effect.gen(function* () {
        yield* seed

        for (const userId of ["stranger", "relay-viewer"]) {
          const user = sessionUser(userId)
          assert.instanceOf(
            yield* refusal(getResourceOwnerHandler(user, scope(ownedId))),
            Error
          )
        }
      })
    )

    it.effect("Relay access that can read servers sees their owner", () =>
      Effect.gen(function* () {
        yield* seed

        const owner = yield* ownerFor("relay-player", ownedId)

        assert.deepStrictEqual(owner, {
          email: null,
          name: "Steve",
          userId: "owner",
        })
      })
    )

    it.effect("a server no one owns is the platform's", () =>
      Effect.gen(function* () {
        yield* seed

        const owner = yield* ownerFor("player", unownedId)

        assert.isNull(owner)
      })
    )
  })
})
