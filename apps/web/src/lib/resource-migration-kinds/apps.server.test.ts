import { assert, layer } from "@effect/vitest"
import {
  relayCertificateReleaseInputSchema,
  relayInstanceWebRoutesWriteSchema,
  type RelayInstanceWebRouteInput,
} from "@workspace/contracts"
import { Effect, Layer } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import {
  loadPrimaryAddressEffect,
  setPrimaryAddressEffect,
} from "@/effect/primary-addresses"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { activeRelay } from "@/lib/relay-registry"
import { apps } from "@/lib/resource-migration-kinds/apps.server"
import type { Migration } from "@/lib/resource-migration-kinds/kind.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

type Route = RelayInstanceWebRouteInput & { id: string }

// The Relays are the only fake: each keeps the routes it is sent, as a real
// one checks them, giving each an ID of its own.
const fake = vi.hoisted(() => ({
  // Whose certificates each Relay isn't to ask for yet.
  held: new Map<string, boolean>(),
  ids: 0,
  // What the next request to each Relay to keep routes fails with.
  refuses: new Map<string, string>(),
  // The hostnames whose certificates may be asked for again.
  released: new Set<string>(),
  routes: new Map<string, Array<object>>(),
  unreadable: false,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: { id: string }
  ) => {
    // Neither App is deployed.
    if (operation === "app.list") return []
    if (operation === "relay.certificates.release") {
      const { hostnames } = relayCertificateReleaseInputSchema.parse(payload)
      for (const hostname of hostnames) fake.released.add(hostname)
      return {}
    }
    const key = `${relay.id}/${payload.id}`
    if (operation === "instance.network.routes.write") {
      const refused = fake.refuses.get(relay.id)
      fake.refuses.delete(relay.id)
      if (refused) throw new Error(refused)
      const { holdCertificates, routes } =
        relayInstanceWebRoutesWriteSchema.parse(payload)
      fake.held.set(key, holdCertificates ?? false)
      fake.routes.set(
        key,
        routes.map((route) => ({
          ...route,
          id: route.id ?? (++fake.ids).toString(16).padStart(8, "0"),
        }))
      )
    } else if (operation !== "instance.network.routes.read") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    } else if (fake.unreadable) {
      throw new Error("The Relay is away")
    }
    return {
      edgeConnected: true,
      message: "Ready",
      proxyConnected: true,
      requiresRestart: false,
      routes: fake.routes.get(key) ?? [],
      status: "ready",
    }
  },
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const oldRelay = "1".repeat(12)
const newRelay = "2".repeat(12)
const oldApp = "a".repeat(12)
const newApp = "b".repeat(12)

const mover: AuthenticatedUser = {
  email: "mover@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "mover",
  isDevelopmentBypass: false,
  name: "Mover",
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}

const migration: Migration = {
  backupStorageIds: [],
  createKey: "00000000-0000-4000-8000-000000000000",
  destination: { id: newApp, name: "Website", relayId: newRelay },
  kind: "app",
  mode: "migrate",
  source: { id: oldApp, name: "Website", relayId: oldRelay },
}

const route = (
  id: string,
  hostname: string,
  service: string,
  path: string | null = null
): Route => ({
  hostname,
  httpsRedirect: true,
  id,
  name: "",
  path,
  redirect: null,
  service,
  stripPrefix: true,
  targetPort: 3000,
  www: "none",
})

const routesOf = (relayId: string, appId: string) =>
  ((fake.routes.get(`${relayId}/${appId}`) ?? []) as Array<Route>).map(
    ({ hostname, path, service }) => `${hostname}${path ?? ""} -> ${service}`
  )

// The old App serves two services, and its second domain is its primary.
const seed = Effect.gen(function* () {
  yield* resetDatabase
  fake.held.clear()
  fake.released.clear()
  fake.refuses.clear()
  fake.routes.clear()
  fake.unreadable = false
  yield* insertUser(mover.id)
  yield* insertRelay(oldRelay, { created_by: mover.id, name: "Old" })
  yield* insertRelay(newRelay, { created_by: mover.id, name: "New" })
  fake.routes.set(`${oldRelay}/${oldApp}`, [
    route("aaaaaaaa", "example.test", "web"),
    route("bbbbbbbb", "example.test", "api", "/api"),
    route("cccccccc", "www.example.test", "web"),
  ])
  yield* setPrimaryAddressEffect(
    { id: oldApp, type: "app" },
    { kind: "route", ref: "bbbbbbbb" }
  )
})

const everyRoute = [
  "example.test -> web",
  "example.test/api -> api",
  "www.example.test -> web",
]

const handOver = Effect.suspend(() => apps.handOver.routes!(migration, mover))

// Where the copy's primary address leads, as its Relay keeps that route.
const primaryOfCopy = Effect.gen(function* () {
  const primary = yield* loadPrimaryAddressEffect({ id: newApp, type: "app" })
  const kept = (fake.routes.get(`${newRelay}/${newApp}`) ?? []) as Array<Route>
  const found = kept.find((candidate) => candidate.id === primary?.ref)
  return found ? `${found.hostname}${found.path ?? ""}` : null
})

const handedOver = Effect.gen(function* () {
  assert.deepEqual(routesOf(newRelay, newApp), everyRoute)
  assert.deepEqual(routesOf(oldRelay, oldApp), [])
  // Its names point at its Relay now, so their certificates are asked for.
  assert.sameMembers([...fake.released], ["example.test", "www.example.test"])
  assert.strictEqual(yield* primaryOfCopy, "example.test/api")
  assert.isNull(yield* loadPrimaryAddressEffect({ id: oldApp, type: "app" }))
})

const namesOf = (appId: string, relayId: string) =>
  Effect.promise(async () =>
    apps
      .handOverCounts(await activeRelay(relayId), appId, mover, {
        backups: true,
        network: true,
      })
      .then((counts) => counts.webRoutes)
  )

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

describeMysql("handing an App's domains to the one it moved to", () => {
  layer(Layer.mergeAll(TestDatabase, disabledCache))((it) => {
    // They were read as a game server's, whose routes name no service, and
    // offered as none: the move left every domain behind.
    it.effect("says which it has, and never takes unreadable for none", () =>
      Effect.gen(function* () {
        yield* seed
        assert.deepEqual(yield* namesOf(oldApp, oldRelay), [
          "example.test",
          "www.example.test",
        ])
        assert.deepEqual(yield* namesOf(newApp, newRelay), [])
        fake.unreadable = true
        assert.isNull(yield* namesOf(oldApp, oldRelay))
      })
    )

    it.effect("keeps each one's service, and which is primary", () =>
      Effect.gen(function* () {
        yield* seed
        yield* handOver
        yield* handedOver
        // Asked again, it changes nothing more.
        yield* handOver
        yield* handedOver
      })
    )

    it.effect("finishes what was cut short between the two Relays", () =>
      Effect.gen(function* () {
        yield* seed
        fake.refuses.set(oldRelay, "Connection lost")
        assert.match(String(yield* Effect.flip(handOver)), /Connection lost/u)
        assert.deepEqual(routesOf(oldRelay, oldApp), everyRoute)
        assert.isTrue(fake.held.get(`${newRelay}/${newApp}`))
        assert.strictEqual(fake.released.size, 0)
        yield* handOver
        yield* handedOver
      })
    )

    it.effect(
      "leaves a primary address that is no domain with the old one",
      () =>
        Effect.gen(function* () {
          yield* seed
          const tunnel = { kind: "tunnel", ref: "tunnel-name" } as const
          yield* setPrimaryAddressEffect({ id: oldApp, type: "app" }, tunnel)
          yield* handOver
          assert.deepEqual(routesOf(newRelay, newApp), everyRoute)
          assert.deepEqual(
            yield* loadPrimaryAddressEffect({ id: oldApp, type: "app" }),
            tunnel
          )
          assert.isNull(
            yield* loadPrimaryAddressEffect({ id: newApp, type: "app" })
          )
        })
    )
  })
})
