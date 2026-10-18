import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { relayProxyConfigurationV1Feature } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { relayWebRoutesHandler } from "@/server/relay-web-routes.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows } from "@/test/seed"

const relayId = "r".repeat(43)
const serverId = "a".repeat(40)
const siblingId = "b".repeat(40)
const appId = "c".repeat(40)

const route = (
  id: string,
  hostname: string,
  owner: { id: string; kind: "app" | "server" }
) => ({
  hostname,
  id,
  name: id,
  owner: { ...owner, service: owner.kind === "app" ? "web" : null },
  path: null,
  stripPrefix: true,
  targetPort: 8080,
  upstream: "http://upstream:8080",
})

// The Relay is the only network boundary: it serves its proxy's routes,
// one for each of two game servers and one for an app.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayProxyConfigurationV1Feature]),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation !== "relay.proxy.config.read")
      throw new Error("Relay is offline")
    return {
      dynamicConfiguration: null,
      staticConfiguration: null,
      routes: [
        route("one", "map.example.test", { id: serverId, kind: "server" }),
        route("two", "other.example.test", { id: siblingId, kind: "server" }),
        route("three", "site.example.test", { id: appId, kind: "app" }),
      ],
    }
  },
}))

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
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

const grant = (
  resourceType: "instance" | "relay",
  resourceId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      userId: user.id,
      relayId,
      resourceType,
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

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
})

const hostnames = Effect.promise(() =>
  relayWebRoutesHandler(user, relayId)
).pipe(Effect.map((routes) => routes?.map((route) => route.hostname)))

describeMysql("Relay web routes on the infrastructure map", () => {
  layer(TestDatabase)((it) => {
    it.effect("reading the Relay alone reveals no routes", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant("relay", relayId, ["relay.read"])

        assert.deepStrictEqual(yield* hostnames, [])
      })
    )

    it.effect("a game server's network grant reveals only its routes", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant("relay", relayId, ["relay.read"])
        yield* grant("instance", serverId, ["instance.network.read"])

        assert.deepStrictEqual(yield* hostnames, ["map.example.test"])
      })
    )

    it.effect("reading the Relay's apps reveals app routes", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant("relay", relayId, ["relay.read", "app.read"])

        assert.deepStrictEqual(yield* hostnames, ["site.example.test"])
      })
    )

    it.effect("routes stay hidden without reading the Relay", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant("instance", serverId, ["instance.network.read"])

        const rejected = yield* Effect.tryPromise(() =>
          relayWebRoutesHandler(user, relayId)
        ).pipe(Effect.flip)

        assert.isDefined(rejected)
      })
    )
  })
})
