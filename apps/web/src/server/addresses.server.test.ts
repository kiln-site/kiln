import { assert, layer } from "@effect/vitest"
import { relayInstanceSchema, type RelayInstance } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"

import { disposeAppRuntime, runAppEffect } from "@/effect/runtime"
import type { WebHostnameResource } from "@/effect/addresses"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { reconcileDueDnsEffect } from "@/lib/dns-worker.server"
import { betterAuthSecrets } from "@/lib/environment"
import { runOperationPromise } from "@/operations/operation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertInstance,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

import { encryptWithKeyring } from "../../keyring.mjs"

import {
  createInstanceDomainHandler,
  getInstanceDomainHandler,
  moveInstanceDomainsEffect,
  moveResourceWebHostnamesEffect,
  provisionInstanceDomain,
  removeInstanceDomainHandler,
  removeRelayAddressesEffect,
  updateInstanceDomainHandler,
} from "./addresses.server"
import {
  getDomainSettingsHandler,
  resyncDomainAssignmentsHandler,
} from "./domain-settings.server"
import {
  generateAppHostnameBestEffort,
  getResourceWebHostnamesHandler,
  releaseWebHostnameHandler,
} from "./web-hostname-access.server"
import { saveWebRoutes } from "./web-routes.server"

// How a game server's addresses, an App's address and the hostnames their
// web routes answer on behave together, as Cloudflare and the pages that
// read them see it. Two stores hold these names today and are to become
// one: nothing here says which store a name is in, so it should all still
// hold afterwards. What is meant to change then is marked where it is.

// A platform administrator: who may do what is other suites' to test.
const user = vi.hoisted((): AuthenticatedUser => ({
  email: "owner@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "owner",
  isDevelopmentBypass: false,
  name: "owner",
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}))
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireEligibleResourceUser: async () => user,
}))
// Everyone may do everything here, but for the permissions a test takes
// away to see what they guard.
const access = vi.hoisted(() => ({ lacks: new Set<string>() }))
vi.mock("@/lib/access-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-control")>()),
  requireRelayPermission: async ({ permission }: { permission: string }) => {
    if (access.lacks.has(permission)) throw new Error("Forbidden")
  },
}))

// The Relays are a boundary: each lists the game servers it runs, as its
// snapshot does, and keeps the routes it is sent. None is connected, so
// where a Relay is reached for the web is the address Hearth has for it.
const relays = vi.hoisted(() => ({
  instances: {} as Record<string, Array<unknown>>,
  /** Refuses to save routes, as a Relay that is away would. */
  refusesRoutes: false,
  /** The routes each instance has, by its ID, as last saved. */
  routes: {} as Record<string, Array<{ hostname: string }>>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: { id?: string; routes?: Array<{ hostname: string }> }
  ) => {
    const routeState = (routes: Array<{ hostname: string }>) => ({
      edgeConnected: true,
      message: "Ready",
      proxyConnected: true,
      requiresRestart: false,
      routes,
      status: "ready",
    })
    if (operation === "relay.snapshot") {
      return {
        instances: relays.instances[relay.id] ?? [],
        node: {
          arch: "arm64",
          connectedAt: "2026-01-01T00:00:00.000Z",
          cpu: { cores: 4, loadPercent: 0 },
          docker: { available: true, version: "test" },
          id: relay.id,
          memory: { totalBytes: 1, usedBytes: 0 },
          name: "Relay",
          platform: "linux",
          storage: { totalBytes: 1, usedBytes: 0 },
          version: "test",
        },
      }
    }
    if (operation === "instance.network.routes.read") {
      return routeState(relays.routes[payload.id ?? ""] ?? [])
    }
    if (operation === "instance.network.routes.write") {
      if (relays.refusesRoutes) throw new Error("The Relay is away")
      const saved = (payload.routes ?? []).map((route, index) => ({
        ...route,
        id: `0000000${index}`,
      }))
      relays.routes[payload.id ?? ""] = saved
      return routeState(saved)
    }
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const relayOne = "1".repeat(12)
const relayTwo = "2".repeat(12)
const serverId = "a".repeat(12)
const otherServerId = "b".repeat(12)
const movedServerId = "c".repeat(12)
const appId = "d".repeat(12)
// Kiln's own vanity domain, the default, which anyone gets an address under.
const zone = { id: "f".repeat(32), name: "kiln.test" }
// Where Hearth reaches a Relay, which is where its web routes are served.
const webHost = (relayId: string) => `${relayId}.relay.test`

interface FakeRecord {
  comment?: string
  content?: string
  data?: { port: number; target: string }
  name: string
  proxied?: boolean
  type: string
}

// Cloudflare is the other boundary: one zone, a set of DNS records by ID,
// which can refuse to delete the records under some names for a while, or
// to move a record to some.
function fakeCloudflare() {
  const records = new Map<string, FakeRecord>()
  const refusesDeleting = new Set<string>()
  const refusesNaming = new Set<string>()
  let nextId = 0
  const success = (result: unknown) =>
    Response.json({ errors: [], result, success: true })
  const failure = (status: number, code?: number) =>
    Response.json(
      {
        errors: [{ code, message: "Cloudflare is unavailable" }],
        success: false,
      },
      { status }
    )
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      const recordId = url.pathname.split("/")[6] ?? ""
      if (url.pathname.endsWith("/zones")) {
        return success([{ ...zone, status: "active" }])
      }
      if (method === "GET") {
        const name = url.searchParams.get("name")
        return success(
          [...records]
            .filter(([, record]) => record.name === name)
            .map(([id, record]) => ({
              ...record,
              comment: record.comment ?? null,
              id,
            }))
        )
      }
      const create = (body: FakeRecord) => {
        nextId += 1
        const id = `record-${nextId}`
        records.set(id, body)
        return { id, name: body.name, type: body.type }
      }
      if (method === "POST" && recordId === "batch") {
        const batch = JSON.parse(String(init?.body)) as {
          deletes: Array<{ id: string }>
          posts: Array<FakeRecord>
        }
        if (batch.deletes.some(({ id }) => !records.has(id))) {
          return failure(404, 81_044)
        }
        for (const { id } of batch.deletes) records.delete(id)
        return success({ posts: batch.posts.map(create) })
      }
      if (method === "POST") {
        return success(create(JSON.parse(String(init?.body)) as FakeRecord))
      }
      const found = records.get(recordId)
      // Gone, as one deleted in Cloudflare's dashboard is.
      if (!found) return failure(404, 81_044)
      if (method === "DELETE") {
        if (refusesDeleting.has(found.name)) return failure(503)
        records.delete(recordId)
        return success({ id: recordId })
      }
      const body = JSON.parse(String(init?.body)) as FakeRecord
      if (refusesNaming.has(body.name)) return failure(503)
      records.set(recordId, body)
      return success({ id: recordId, name: body.name, type: body.type })
    })
  )
  return {
    /** Deletes what is under a name, as someone in the dashboard would. */
    deleteByHand: (name: string) => {
      for (const [id, record] of records) {
        if (record.name === name) records.delete(id)
      }
    },
    /** Every record: `TYPE name content`, or an SRV's port and target. */
    records: () =>
      [...records.values()]
        .map((record) =>
          record.type === "SRV"
            ? `SRV ${record.name} ${record.data?.port} ${record.data?.target}`
            : `${record.type} ${record.name} ${record.content}${record.proxied ? " (proxied)" : ""}`
        )
        .sort(),
    refusesDeleting,
    refusesNaming,
  }
}

// A game server as its Relay reports it: one players join by name, unless
// it says otherwise.
const gameServer = (id: string, change: Partial<RelayInstance> = {}) =>
  relayInstanceSchema.parse({
    brickPrimaryPortProtocol: "tcp",
    brickType: "minecraft",
    connectAddress: "203.0.113.10:25565",
    containerId: "container",
    desiredState: "running",
    directory: id,
    game: "Minecraft",
    id,
    implementation: "Paper",
    javaVersion: "21",
    name: id,
    observedState: "running",
    publicHost: "203.0.113.10",
    publicPort: 25_565,
    service: id,
    status: "running",
    version: "1.21.11",
    ...change,
  })

const server = {
  relayId: relayOne,
  resourceId: serverId,
  resourceType: "instance",
} as const
const app = {
  relayId: relayOne,
  resourceId: appId,
  resourceType: "app",
} as const

const seed = Effect.gen(function* () {
  yield* resetDatabase
  relays.instances = {}
  relays.refusesRoutes = false
  relays.routes = {}
  access.lacks.clear()
  yield* insertRelay(relayOne)
  yield* insertRelay(relayTwo)
  yield* insertRows("domain_integration", {
    id: "cloudflare",
    provider: "cloudflare",
    owner_id: null,
    name: "Cloudflare",
    api_token_ciphertext: encryptWithKeyring(
      "api-token",
      betterAuthSecrets(),
      "kiln-cloudflare-api-token"
    ),
    blacklist_patterns: "[]",
    zones: JSON.stringify([zone]),
    last_verified_at: Date.now(),
    created_at: 0,
    updated_at: 0,
  })
  yield* insertRows("domain_zone", {
    domain: zone.name,
    integration_id: "cloudflare",
    zone_id: zone.id,
    zone_name: zone.name,
    is_default: true,
    enabled: true,
    created_at: 0,
    updated_at: 0,
  })
})

// A game server on a Relay, which its Relay lists from then on.
const runs = (relayId: string, instance: RelayInstance) =>
  Effect.gen(function* () {
    yield* insertInstance(relayId, instance.id, { owner_id: user.id })
    relays.instances[relayId] = [...(relays.instances[relayId] ?? []), instance]
  })

const hasApp = insertRows("app", {
  app_id: appId,
  relay_id: relayOne,
  name: "Shop",
  config_ciphertext: "config",
  created_by: user.id,
  owner_id: user.id,
  created_at: 0,
  updated_at: 0,
})

// Giving a game server an address by a name someone chose, as its Network
// page does.
const addAddress = (relayId: string, instanceId: string, name: string) =>
  Effect.promise(() =>
    createInstanceDomainHandler({
      domain: zone.name,
      instanceId,
      primary: true,
      relayId,
      vanityLabel: name,
    })
  )

// The address a game server's Network page shows for it.
const addressOf = (relayId: string, instanceId: string) =>
  Effect.promise(() => getInstanceDomainHandler({ instanceId, relayId })).pipe(
    Effect.map(({ assignment }) => assignment)
  )

// The ID the Domains page knows one of a game server's addresses by.
const addressId = (name: string) =>
  Effect.promise(() => getDomainSettingsHandler()).pipe(
    Effect.map(
      (settings) =>
        settings.managedDomains.find((domain) => domain.vanityLabel === name)
          ?.id ?? ""
    )
  )

const route = {
  httpsRedirect: true,
  name: "",
  path: null,
  primary: false,
  redirect: null,
  stripPrefix: true,
  targetPort: 8080,
  www: "none" as const,
}

// Saving an instance's web routes, one for each hostname, as its Network
// page does: a rejected save says why.
const saveRoutes = (
  resource: WebHostnameResource,
  hostnames: ReadonlyArray<string>,
  proxied?: ReadonlyArray<string>
) =>
  Effect.promise(() =>
    runOperationPromise(
      saveWebRoutes,
      {
        ...(resource.resourceType === "app"
          ? {
              ...resource,
              resourceType: "app" as const,
              routes: hostnames.map((hostname) => ({
                ...route,
                hostname,
                service: "web",
              })),
            }
          : {
              ...resource,
              resourceType: "instance" as const,
              routes: hostnames.map((hostname) => ({ ...route, hostname })),
            }),
        ...(proxied ? { proxy: { hostnames: proxied, proxied: true } } : {}),
      },
      { user }
    ).then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    )
  )

// The hostnames an instance's Network page lists for its routes.
const routeHostnames = (resource: WebHostnameResource) =>
  Effect.promise(() => getResourceWebHostnamesHandler(resource)).pipe(
    Effect.map(({ hostnames }) => hostnames)
  )

// And how each stands, by name.
const routeStatuses = (resource: WebHostnameResource) =>
  routeHostnames(resource).pipe(
    Effect.map((hostnames) =>
      Object.fromEntries(
        hostnames.map(({ hostname, lastError, status }) => [
          hostname,
          lastError ? `${status}: ${lastError}` : status,
        ])
      )
    )
  )

// Who holds each name Kiln keeps.
const claims = Effect.map(
  selectRows<{
    hostname: string
    relay_id: string
    resource_id: string
    resource_type: string
  }>("hostname_claim"),
  (rows) =>
    Object.fromEntries(
      rows.map((row) => [
        row.hostname,
        `${row.resource_type} ${row.resource_id} on ${row.relay_id.trim()}`,
      ])
    )
)

// The hostnames an instance's Relay serves its routes on, as last saved.
const routedOn = (instanceId: string) =>
  (relays.routes[instanceId] ?? []).map((saved) => saved.hostname)

// One pass of the DNS worker, which finishes what requests leave undone.
const dnsWorkerPass = Effect.promise(() =>
  runAppEffect("Domains.dns.pass", reconcileDueDnsEffect)
)

const refused = <A>(run: () => Promise<A>) =>
  Effect.promise(() =>
    run().then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    )
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => disposeAppRuntime())

describeMysql("a game server's address and its web routes", () => {
  layer(TestDatabase)((it) => {
    // A game server with an address, and a web route on that same name.
    const routedAddress = Effect.gen(function* () {
      yield* seed
      const cloudflare = fakeCloudflare()
      yield* runs(relayOne, gameServer(serverId))
      yield* addAddress(relayOne, serverId, "arena")
      assert.isNull(yield* saveRoutes(server, ["arena.kiln.test"]))
      return cloudflare
    })

    // Players join at the name and a website answers on it: one name has
    // one address record, and it is where players connect. A second record
    // for the route would point the name at two places.
    it.effect(
      "keeps one record for a name that is both its address and a route's",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* routedAddress

          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
          assert.deepEqual(yield* routeStatuses(server), {
            "arena.kiln.test": "active",
          })
          assert.deepEqual(yield* claims, {
            "arena.kiln.test": `instance ${serverId} on ${relayOne}`,
          })
          // Players connect to it directly, so it can't sit behind a proxy
          // that only carries web traffic.
          assert.include(
            yield* saveRoutes(server, ["arena.kiln.test"], ["arena.kiln.test"]),
            "can't go through Cloudflare's proxy"
          )
          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
        })
    )

    // The website keeps answering on the name once it stops being where
    // players join: the name isn't let go for someone else to take, and it
    // points at the Relay's web proxy from then on.
    it.effect(
      "leaves the name to the route, pointed at its Relay, when the address is removed",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* routedAddress

          const id = yield* addressId("arena")
          yield* Effect.promise(() => removeInstanceDomainHandler({ id }))
          yield* dnsWorkerPass

          assert.deepEqual(cloudflare.records(), [
            `CNAME arena.kiln.test ${webHost(relayOne)}`,
          ])
          assert.isNull(yield* addressOf(relayOne, serverId))
          assert.deepEqual(yield* routeStatuses(server), {
            "arena.kiln.test": "active",
          })
          assert.deepEqual(yield* claims, {
            "arena.kiln.test": `instance ${serverId} on ${relayOne}`,
          })
        })
    )

    // The website is on the address: renamed, both are at the new name, and
    // the old one is let go for anyone to take. Players' records move by
    // their IDs, so the name they join at is never without them.
    it.effect(
      "moves its records, and the route on it, to the new name when the address is renamed",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* routedAddress

          const id = yield* addressId("arena")
          yield* Effect.promise(() =>
            updateInstanceDomainHandler({
              domain: zone.name,
              id,
              primary: true,
              vanityLabel: "colosseum",
            })
          )
          yield* dnsWorkerPass

          // Players join at the new name, by name as before.
          assert.strictEqual(
            (yield* addressOf(relayOne, serverId))?.address,
            "colosseum.kiln.test"
          )
          const records = cloudflare.records()
          assert.includeMembers(records, [
            "A colosseum.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.colosseum.kiln.test 25565 colosseum.kiln.test",
          ])
          assert.notInclude(
            records.join("\n"),
            "_minecraft._tcp.arena.kiln.test"
          )

          // The route followed it: its Relay serves the new name, which has
          // the one record, and the old name is nobody's.
          assert.deepEqual(routedOn(serverId), ["colosseum.kiln.test"])
          assert.deepEqual(records, [
            "A colosseum.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.colosseum.kiln.test 25565 colosseum.kiln.test",
          ])
          assert.deepEqual(yield* routeStatuses(server), {
            "colosseum.kiln.test": "active",
          })
          assert.deepEqual(yield* claims, {
            "colosseum.kiln.test": `instance ${serverId} on ${relayOne}`,
          })
        })
    )

    // Players' address can't wait for a Relay that is away: the rename
    // stands. The website stays where its Relay still serves it, on a name
    // that keeps a record and isn't let go, and the person is told.
    it.effect(
      "leaves the route on the old name, still served, when its Relay can't take the change",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* routedAddress

          const id = yield* addressId("arena")
          relays.refusesRoutes = true
          const told = yield* refused(() =>
            updateInstanceDomainHandler({
              domain: zone.name,
              id,
              primary: true,
              vanityLabel: "colosseum",
            })
          )
          yield* dnsWorkerPass

          assert.include(told, "still answers on arena.kiln.test")
          assert.strictEqual(
            (yield* addressOf(relayOne, serverId))?.address,
            "colosseum.kiln.test"
          )
          assert.deepEqual(routedOn(serverId), ["arena.kiln.test"])
          assert.deepEqual(cloudflare.records(), [
            "A colosseum.kiln.test 203.0.113.10",
            `CNAME arena.kiln.test ${webHost(relayOne)}`,
            "SRV _minecraft._tcp.colosseum.kiln.test 25565 colosseum.kiln.test",
          ])
          assert.deepEqual(yield* claims, {
            "arena.kiln.test": `instance ${serverId} on ${relayOne}`,
            "colosseum.kiln.test": `instance ${serverId} on ${relayOne}`,
          })
        })
    )

    // A rename holds both names until Cloudflare has the new one. A website
    // put on the new name meanwhile is on the address's name, as one saved
    // after the rename would be: the two must not end up as two holders of
    // one name, each with a record.
    it.effect(
      "takes in a route saved on the name a rename is moving it to",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare()
          yield* runs(relayOne, gameServer(serverId))
          yield* addAddress(relayOne, serverId, "arena")
          const id = yield* addressId("arena")
          cloudflare.refusesNaming.add("colosseum.kiln.test")
          assert.include(
            yield* refused(() =>
              updateInstanceDomainHandler({
                domain: zone.name,
                id,
                primary: true,
                vanityLabel: "colosseum",
              })
            ),
            "Kiln will keep trying"
          )

          assert.isNull(yield* saveRoutes(server, ["colosseum.kiln.test"]))

          // Players still join at the old name, and the new one waits for
          // the rename without a record of its own.
          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
          assert.deepEqual(yield* routeStatuses(server), {
            "colosseum.kiln.test": "pending",
          })

          cloudflare.refusesNaming.clear()
          yield* dnsWorkerPass

          assert.deepEqual(cloudflare.records(), [
            "A colosseum.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.colosseum.kiln.test 25565 colosseum.kiln.test",
          ])
          assert.strictEqual(
            (yield* addressOf(relayOne, serverId))?.address,
            "colosseum.kiln.test"
          )
          assert.deepEqual(yield* routeStatuses(server), {
            "colosseum.kiln.test": "active",
          })
          assert.deepEqual(yield* claims, {
            "colosseum.kiln.test": `instance ${serverId} on ${relayOne}`,
          })
          // One hostname, held once.
          assert.deepEqual(
            (yield* selectRows<{ hostname: string }>("instance_address")).map(
              (row) => row.hostname
            ),
            ["colosseum.kiln.test"]
          )
          // And nothing left for the worker to make a second record from.
          yield* dnsWorkerPass
          assert.deepEqual(cloudflare.records(), [
            "A colosseum.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.colosseum.kiln.test 25565 colosseum.kiln.test",
          ])
        })
    )
  })
})

describeMysql("the records a game server's address has", () => {
  layer(TestDatabase)((it) => {
    // An SRV record is what lets players join by name alone. It names the
    // port, so one left behind when the port changes sends them nowhere.
    it.effect(
      "has an SRV record where its Brick lets players join by name, which follows its port",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare()
          const craft = gameServer(serverId)
          yield* runs(relayOne, craft)
          // One whose game has no such lookup: players type its port.
          yield* runs(
            relayOne,
            gameServer(otherServerId, {
              brickPrimaryPortProtocol: "udp",
              brickType: undefined,
              connectAddress: "203.0.113.10:2456",
              game: "Valheim",
              implementation: "Valheim",
              publicPort: 2456,
            })
          )
          yield* addAddress(relayOne, serverId, "craft")
          yield* addAddress(relayOne, otherServerId, "viking")

          assert.deepEqual(cloudflare.records(), [
            "A craft.kiln.test 203.0.113.10",
            "A viking.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.craft.kiln.test 25565 craft.kiln.test",
          ])
          assert.strictEqual(
            (yield* addressOf(relayOne, serverId))?.address,
            "craft.kiln.test"
          )
          assert.strictEqual(
            (yield* addressOf(relayOne, otherServerId))?.address,
            "viking.kiln.test:2456"
          )

          // Its Relay reports it somewhere else, as after its port changes.
          yield* Effect.promise(() =>
            provisionInstanceDomain(
              {
                ...craft,
                connectAddress: "203.0.113.20:25570",
                publicHost: "203.0.113.20",
                publicPort: 25_570,
              },
              relayOne
            )
          )

          assert.deepEqual(cloudflare.records(), [
            "A craft.kiln.test 203.0.113.20",
            "A viking.kiln.test 203.0.113.10",
            "SRV _minecraft._tcp.craft.kiln.test 25570 craft.kiln.test",
          ])
        })
    )
  })
})

describeMysql("a game server's names when it or its Relay goes", () => {
  layer(TestDatabase)((it) => {
    // A game server with an address players join at, a web route on that
    // name, and another on a name of its own.
    const served = Effect.gen(function* () {
      yield* seed
      const cloudflare = fakeCloudflare()
      yield* runs(relayOne, gameServer(serverId))
      yield* addAddress(relayOne, serverId, "arena")
      assert.isNull(
        yield* saveRoutes(server, ["arena.kiln.test", "map.kiln.test"])
      )
      assert.deepEqual(cloudflare.records(), [
        "A arena.kiln.test 203.0.113.10",
        `CNAME map.kiln.test ${webHost(relayOne)}`,
        "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
      ])
      return cloudflare
    })

    // Moving a game server to another Relay makes a new server there. Its
    // names have to go with it: players and visitors keep the same names,
    // and none may be left held by a server that is gone.
    it.effect(
      "gives every name to the server that takes its place on another Relay",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* served
          const moved = gameServer(movedServerId, {
            connectAddress: "203.0.113.20:25566",
            publicHost: "203.0.113.20",
            publicPort: 25_566,
          })
          yield* runs(relayTwo, moved)
          const taking = {
            relayId: relayTwo,
            resourceId: movedServerId,
            resourceType: "instance",
          } as const

          // As moving a server does: its addresses, then its routes' names.
          yield* Effect.promise(() =>
            runAppEffect(
              "domains.instance.move",
              moveInstanceDomainsEffect(
                { instanceId: serverId, relayId: relayOne },
                { ...moved, relayId: relayTwo }
              )
            )
          )
          yield* Effect.promise(() =>
            runAppEffect(
              "webHostnames.move",
              moveResourceWebHostnamesEffect(server, taking)
            )
          )

          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.20",
            `CNAME map.kiln.test ${webHost(relayTwo)}`,
            "SRV _minecraft._tcp.arena.kiln.test 25566 arena.kiln.test",
          ])
          assert.deepEqual(yield* claims, {
            "arena.kiln.test": `instance ${movedServerId} on ${relayTwo}`,
            "map.kiln.test": `instance ${movedServerId} on ${relayTwo}`,
          })
          assert.strictEqual(
            (yield* addressOf(relayTwo, movedServerId))?.address,
            "arena.kiln.test"
          )
          assert.deepEqual(yield* routeStatuses(taking), {
            "arena.kiln.test": "active",
            "map.kiln.test": "active",
          })
          // Nothing is left with the old one.
          assert.isNull(yield* addressOf(relayOne, serverId))
          assert.deepEqual(yield* routeStatuses(server), {})
        })
    )

    // Removing a Relay with its records leaves nothing of it in Cloudflare
    // and no name held, even when Cloudflare refuses some deletes at first:
    // a name let go while its record remains could be given to someone
    // else under a record that still points at the old Relay.
    it.effect(
      "deletes every record and lets go of every name when its Relay is removed, finishing what Cloudflare refused",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* served
          yield* hasApp
          yield* Effect.promise(() => generateAppHostnameBestEffort(app))
          cloudflare.refusesDeleting.add("_minecraft._tcp.arena.kiln.test")
          cloudflare.refusesDeleting.add("map.kiln.test")

          // As removing a Relay does.
          yield* Effect.promise(() =>
            runAppEffect(
              "addresses.removeRelay",
              removeRelayAddressesEffect(relayOne, true)
            )
          )

          // What Cloudflare kept is still held, so nobody takes the name.
          assert.deepEqual(cloudflare.records(), [
            `CNAME map.kiln.test ${webHost(relayOne)}`,
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
          assert.deepEqual(yield* claims, {
            "arena.kiln.test": `instance ${serverId} on ${relayOne}`,
            "map.kiln.test": `instance ${serverId} on ${relayOne}`,
          })

          cloudflare.refusesDeleting.clear()
          yield* dnsWorkerPass

          assert.deepEqual(cloudflare.records(), [])
          assert.deepEqual(yield* claims, {})
        })
    )

    // Sync is how a person repairs DNS after something changed it behind
    // Kiln's back, such as a record deleted in Cloudflare's dashboard.
    it.effect(
      "makes a route's record again on Sync when it was deleted in Cloudflare",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* served
          cloudflare.deleteByHand("map.kiln.test")
          cloudflare.deleteByHand("arena.kiln.test")

          yield* Effect.promise(() => resyncDomainAssignmentsHandler())

          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.10",
            `CNAME map.kiln.test ${webHost(relayOne)}`,
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
          assert.deepEqual(yield* routeStatuses(server), {
            "arena.kiln.test": "active",
            "map.kiln.test": "active",
          })

          // The record players are sent to by name, too.
          cloudflare.deleteByHand("_minecraft._tcp.arena.kiln.test")

          yield* Effect.promise(() => resyncDomainAssignmentsHandler())

          assert.deepEqual(cloudflare.records(), [
            "A arena.kiln.test 203.0.113.10",
            `CNAME map.kiln.test ${webHost(relayOne)}`,
            "SRV _minecraft._tcp.arena.kiln.test 25565 arena.kiln.test",
          ])
        })
    )
  })
})

describeMysql("an App's address", () => {
  layer(TestDatabase)((it) => {
    // A new App gets a name of Kiln's choosing before anything is served
    // there. It is the App's to give up only while no route answers on it:
    // let go under a route, the name could go to someone else while the
    // App's website still answered on it.
    it.effect(
      "is made with the App, kept while a route uses it, and given up only once none does",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare()
          yield* hasApp

          yield* Effect.promise(() => generateAppHostnameBestEffort(app))

          const [address] = yield* routeHostnames(app)
          assert.isDefined(address)
          if (!address) return
          // Two words under the default vanity domain, pointed at its Relay.
          assert.match(address.hostname, /^[a-z]+-[a-z]+(-\d+)?\.kiln\.test$/u)
          assert.deepInclude(address, {
            canRelease: true,
            generated: true,
            status: "active",
          })
          const pointed = [`CNAME ${address.hostname} ${webHost(relayOne)}`]
          assert.deepEqual(cloudflare.records(), pointed)
          assert.deepEqual(yield* claims, {
            [address.hostname]: `app ${appId} on ${relayOne}`,
          })

          // A route answers on it.
          assert.isNull(yield* saveRoutes(app, [address.hostname]))
          assert.isFalse((yield* routeHostnames(app))[0]?.canRelease)
          assert.include(
            yield* refused(() => releaseWebHostnameHandler({ id: address.id })),
            "A web route uses"
          )
          assert.deepEqual(cloudflare.records(), pointed)

          // The route goes, and the address stays the App's.
          assert.isNull(yield* saveRoutes(app, []))
          assert.deepEqual(cloudflare.records(), pointed)
          assert.isTrue((yield* routeHostnames(app))[0]?.canRelease)

          yield* Effect.promise(() =>
            releaseWebHostnameHandler({ id: address.id })
          )
          assert.deepEqual(cloudflare.records(), [])
          assert.deepEqual(yield* routeHostnames(app), [])
          assert.deepEqual(yield* claims, {})
        })
    )

    // Its addresses, as its Network page lists them, main one first.
    const addressesOf = Effect.promise(() =>
      getInstanceDomainHandler({
        instanceId: appId,
        relayId: relayOne,
        resourceType: "app",
      })
    ).pipe(
      Effect.map(({ addresses }) =>
        addresses.map(
          ({ hostname, primary, routed }) =>
            `${hostname}${primary ? " (main)" : ""}${routed ? " (routed)" : ""}`
        )
      )
    )
    const addressNamed = (name: string) =>
      Effect.promise(() =>
        getInstanceDomainHandler({
          instanceId: appId,
          relayId: relayOne,
          resourceType: "app",
        })
      ).pipe(
        Effect.map(
          ({ addresses }) =>
            addresses.find((address) => address.vanityLabel === name)?.id ?? ""
        )
      )
    const addToApp = (name: string, primary = false) =>
      refused(() =>
        createInstanceDomainHandler({
          domain: zone.name,
          instanceId: appId,
          primary,
          relayId: relayOne,
          resourceType: "app",
          vanityLabel: name,
        })
      )
    const rename = (id: string, name: string) =>
      refused(() =>
        updateInstanceDomainHandler({
          domain: zone.name,
          id,
          primary: false,
          vanityLabel: name,
        })
      )
    const remove = (id: string) =>
      refused(() => removeInstanceDomainHandler({ id }))
    // An App with two addresses of its own: `shop`, its main one, and
    // `store`.
    const shop = Effect.gen(function* () {
      yield* seed
      const cloudflare = fakeCloudflare()
      yield* hasApp
      assert.isNull(yield* addToApp("shop"))
      assert.isNull(yield* addToApp("store"))
      return cloudflare
    })

    // An App holds addresses as a game server does: more than one, each
    // with a record from the moment it is added, whether or not anything
    // is served there yet.
    it.effect(
      "is one of as many as it is given, each pointed at its Relay",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* shop

          assert.deepEqual(cloudflare.records(), [
            `CNAME shop.kiln.test ${webHost(relayOne)}`,
            `CNAME store.kiln.test ${webHost(relayOne)}`,
          ])
          assert.deepEqual(yield* addressesOf, [
            "shop.kiln.test (main)",
            "store.kiln.test",
          ])
          assert.deepEqual(routedOn(appId), [])
          assert.deepEqual(yield* claims, {
            "shop.kiln.test": `app ${appId} on ${relayOne}`,
            "store.kiln.test": `app ${appId} on ${relayOne}`,
          })
          // Not held by anyone else, a game server included, under any name.
          yield* runs(relayOne, gameServer(serverId))
          assert.include(
            yield* refused(() =>
              createInstanceDomainHandler({
                domain: zone.name,
                instanceId: serverId,
                primary: true,
                relayId: relayOne,
                vanityLabel: "shop",
              })
            ),
            "already in use"
          )
          yield* addAddress(relayOne, serverId, "arena")
          assert.include(yield* addToApp("arena"), "already in use")
          assert.include(
            yield* rename(yield* addressNamed("store"), "arena"),
            "already in use"
          )
        })
    )

    // The website answers on the address, so renaming the address has to
    // take the website with it, or the name people are told stops working.
    // Its Relay decides: if the route can't be saved there, nothing moves.
    it.effect(
      "takes its route with it when it is renamed, or isn't renamed at all",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* shop
          assert.isNull(
            yield* saveRoutes(app, ["shop.kiln.test"], ["shop.kiln.test"])
          )
          const before = [
            `CNAME shop.kiln.test ${webHost(relayOne)} (proxied)`,
            `CNAME store.kiln.test ${webHost(relayOne)}`,
          ]
          assert.deepEqual(cloudflare.records(), before)

          relays.refusesRoutes = true
          assert.include(
            yield* rename(yield* addressNamed("shop"), "market"),
            "nothing was renamed"
          )
          yield* dnsWorkerPass
          assert.deepEqual(cloudflare.records(), before)
          assert.deepEqual(routedOn(appId), ["shop.kiln.test"])
          assert.deepEqual(yield* addressesOf, [
            "shop.kiln.test (main) (routed)",
            "store.kiln.test",
          ])
          // Its Relay may have taken the route even so: the new name stays
          // the App's, with no record, as a name a failed save of its
          // routes claimed does, so nobody else can take it meanwhile.
          assert.deepEqual(yield* claims, {
            "market.kiln.test": `app ${appId} on ${relayOne}`,
            "shop.kiln.test": `app ${appId} on ${relayOne}`,
            "store.kiln.test": `app ${appId} on ${relayOne}`,
          })

          // Trying again takes that name up.
          relays.refusesRoutes = false
          assert.isNull(yield* rename(yield* addressNamed("shop"), "market"))
          yield* dnsWorkerPass

          // Behind Cloudflare's proxy as it was, and still its main one.
          assert.deepEqual(cloudflare.records(), [
            `CNAME market.kiln.test ${webHost(relayOne)} (proxied)`,
            `CNAME store.kiln.test ${webHost(relayOne)}`,
          ])
          assert.deepEqual(routedOn(appId), ["market.kiln.test"])
          assert.deepEqual(yield* addressesOf, [
            "market.kiln.test (main) (routed)",
            "store.kiln.test",
          ])
          assert.deepEqual(yield* claims, {
            "market.kiln.test": `app ${appId} on ${relayOne}`,
            "store.kiln.test": `app ${appId} on ${relayOne}`,
          })
        })
    )

    // Let go under a route, a name could go to someone else while the App's
    // website still answered on it. One nothing answers on is its to give
    // up, and another takes its place as the main one.
    it.effect(
      "is removed only while no route answers on it, and another becomes its main one",
      () =>
        Effect.gen(function* () {
          const cloudflare = yield* shop
          assert.isNull(yield* saveRoutes(app, ["store.kiln.test"]))

          assert.include(
            yield* remove(yield* addressNamed("store")),
            "A web route uses store.kiln.test"
          )
          assert.isNull(yield* remove(yield* addressNamed("shop")))
          yield* dnsWorkerPass

          assert.deepEqual(cloudflare.records(), [
            `CNAME store.kiln.test ${webHost(relayOne)}`,
          ])
          assert.deepEqual(yield* addressesOf, [
            "store.kiln.test (main) (routed)",
          ])
          assert.deepEqual(yield* claims, {
            "store.kiln.test": `app ${appId} on ${relayOne}`,
          })
        })
    )

    // An address is a public name pointed at the Relay: giving an App one,
    // moving it or taking it away is changing its network.
    it.effect("is changed only by someone who may change its network", () =>
      Effect.gen(function* () {
        const cloudflare = yield* shop
        const before = cloudflare.records()
        const store = yield* addressNamed("store")

        access.lacks.add("instance.network.write")
        assert.include(yield* addToApp("market"), "Forbidden")
        assert.include(yield* rename(store, "market"), "Forbidden")
        assert.include(yield* remove(store), "Forbidden")

        assert.deepEqual(cloudflare.records(), before)
        assert.deepEqual(yield* claims, {
          "shop.kiln.test": `app ${appId} on ${relayOne}`,
          "store.kiln.test": `app ${appId} on ${relayOne}`,
        })
      })
    )
  })
})
