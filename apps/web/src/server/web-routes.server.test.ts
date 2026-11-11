import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { runOperationPromise } from "@/operations/operation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

import { saveWebRoutes } from "./web-routes.server"

const relayId = "1".repeat(12)
const serverId = "a".repeat(12)
const siblingId = "b".repeat(12)
const appId = "c".repeat(12)

// The Relay is the boundary: it keeps the routes it is sent, and says
// whose it was sent.
const relay = vi.hoisted(() => ({
  saved: [] as Array<{ id: string; kind: string }>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { id: string; kind: string; routes: ReadonlyArray<object> }
  ) => {
    if (operation !== "instance.network.routes.write")
      throw new Error(`Unexpected Relay request ${operation}`)
    relay.saved.push({ id: payload.id, kind: payload.kind })
    return {
      edgeConnected: true,
      message: "Ready",
      proxyConnected: true,
      requiresRestart: false,
      routes: payload.routes.map((route, index) => ({
        ...route,
        id: `0000000${index}`,
      })),
      status: "ready",
    }
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const member = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: new Date(at).toISOString(),
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

const grant = (
  userId: string,
  resourceType: "instance" | "relay",
  resourceId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({ id, relayId, resourceId, resourceType, userId })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

const route = {
  hostname: "site.example.test",
  httpsRedirect: true,
  name: "",
  path: null,
  primary: false,
  redirect: null,
  stripPrefix: true,
  targetPort: 8080,
  www: "none" as const,
}

// Whether someone's save reached the Relay, for a game server or an App.
const saves = (
  userId: string,
  of:
    | { resourceId: string; resourceType: "instance" }
    | { resourceId: string; resourceType: "app" }
) =>
  Effect.promise(() =>
    runOperationPromise(
      saveWebRoutes,
      of.resourceType === "app"
        ? { ...of, relayId, routes: [{ ...route, service: "web" }] }
        : { ...of, relayId, routes: [route] },
      { user: member(userId) }
    ).then(
      () => true,
      () => false
    )
  )

describeMysql("Saving an instance's web routes", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "takes changing its network, whatever kind it is, and not configuring an App",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.saved.length = 0
          yield* insertRelay(relayId)
          for (const id of ["networker", "configurer", "neighbour"]) {
            yield* insertUser(id)
          }
          // On a Relay it reaches every game server and App there.
          yield* grant("networker", "relay", relayId, [
            "instance.network.write",
          ])
          // Configuring Apps no longer saves their routes.
          yield* grant("configurer", "relay", relayId, [
            "app.read",
            "app.manage",
          ])
          // On one game server it is that game server's alone.
          yield* grant("neighbour", "instance", siblingId, [
            "instance.network.write",
          ])
          const server = {
            resourceId: serverId,
            resourceType: "instance",
          } as const
          const app = { resourceId: appId, resourceType: "app" } as const

          assert.isTrue(yield* saves("networker", server))
          assert.isTrue(yield* saves("networker", app))
          assert.isFalse(yield* saves("configurer", app))
          assert.isFalse(yield* saves("configurer", server))
          assert.isFalse(yield* saves("neighbour", server))
          assert.isFalse(yield* saves("neighbour", app))
          assert.isTrue(
            yield* saves("neighbour", {
              resourceId: siblingId,
              resourceType: "instance",
            })
          )
          // Only what was allowed reached the Relay, as the kind it is.
          assert.deepStrictEqual(relay.saved, [
            { id: serverId, kind: "instance" },
            { id: appId, kind: "app" },
            { id: siblingId, kind: "instance" },
          ])
        })
    )
  })
})
