import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { getResourceUserCountHandler } from "@/server/resource-access.server"
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
const instanceId = "a".repeat(40)
const siblingId = "b".repeat(40)
const scope = {
  relayId,
  resourceId: instanceId,
  resourceType: "instance",
} as const

const sessionUser = (
  id: string,
  role: AuthenticatedUser["role"] = "user"
): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role,
  status: "enabled",
  twoFactorEnabled: false,
})

const grant = (
  userId: string,
  resource: { resourceId: string; resourceType: "instance" | "relay" },
  permissions: ReadonlyArray<AccessPermission>,
  state: "active" | "pending" | "revoked" = "active"
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({ id, relayId, state, userId, ...resource })
    if (permissions.length === 0) return
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

const onServer = { resourceId: instanceId, resourceType: "instance" } as const
const onRelay = { resourceId: relayId, resourceType: "relay" } as const

const seed = Effect.gen(function* () {
  yield* resetDatabase
  for (const id of [
    "owner",
    "member",
    "invited",
    "removed",
    "relay-reader",
    "relay-other",
    "sibling-member",
    "admin",
  ]) {
    yield* insertUser(id, id === "admin" ? { role: "admin" } : {})
  }
  yield* insertRelay(relayId)
  yield* insertInstance(relayId, instanceId, { owner_id: "owner" })
  yield* grant("member", onServer, ["access.read"])
  yield* grant("invited", onServer, ["instance.read"], "pending")
  yield* grant("removed", onServer, ["instance.read"], "revoked")
  yield* grant("relay-reader", onRelay, ["instance.read"])
  // Relay access that can't read game servers doesn't reach this one.
  yield* grant("relay-other", onRelay, ["relay.read"])
  yield* grant(
    "sibling-member",
    {
      resourceId: siblingId,
      resourceType: "instance",
    },
    ["instance.read"]
  )
})

describeMysql("resource user count", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "counts the owner and invited or active people, not admins or the revoked",
      () =>
        Effect.gen(function* () {
          yield* seed

          const count = yield* Effect.promise(() =>
            getResourceUserCountHandler(sessionUser("admin", "admin"), scope)
          )

          // owner, member, invited, relay-reader
          assert.strictEqual(count, 4)
        })
    )

    it.effect("a member who can read the server's people sees the count", () =>
      Effect.gen(function* () {
        yield* seed

        const count = yield* Effect.promise(() =>
          getResourceUserCountHandler(sessionUser("member"), scope)
        )

        assert.strictEqual(count, 4)
      })
    )

    it.effect("someone who can't read the server's people gets no count", () =>
      Effect.gen(function* () {
        yield* seed

        const count = yield* Effect.promise(() =>
          getResourceUserCountHandler(sessionUser("relay-reader"), scope)
        )

        assert.isNull(count)
      })
    )
  })
})
