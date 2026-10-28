import { assert, layer } from "@effect/vitest"
import { exclusive } from "@workspace/operations"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, afterEach, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { disposeAppRuntime } from "@/effect/runtime"
import { betterAuthSecrets } from "@/lib/environment"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertInstance,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

import { encryptWithKeyring } from "../../keyring.mjs"

import {
  beginInstanceDomainRenameEffect,
  deleteDomainConnectionEffect,
  reassignInstanceDomainsEffect,
  requireConnectionUnusedEffect,
} from "@/effect/domains"
import {
  insertWebHostnameEffect,
  listWebHostnamesEffect,
  markRelayWebHostnamesRemovingEffect,
  type WebHostnameResource,
} from "@/effect/web-hostnames"
import { reconcileDueDnsEffect } from "@/lib/dns-worker.server"
import { quickOperation, runOperation } from "@/operations/run"

import type { DomainActor } from "./domain-access.server"
import {
  deleteResourceWebHostnamesEffect,
  generateAppHostnameEffect,
  moveResourceWebHostnamesEffect,
  reconcileResourceWebHostnamesEffect,
  releaseWebHostnameEffect,
  removeRelayWebHostnamesEffect,
  resyncWebHostnamesEffect,
  saveWebRouteHostnamesEffect,
} from "./web-hostnames.server"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const relayId = "relay-one"
const otherRelayId = "relay-two"
const appId = "a".repeat(40)
const instanceId = "b".repeat(40)
const owner: DomainActor = { admin: false, id: "owner" }
const collaborator: DomainActor = { admin: false, id: "collaborator" }
const admin: DomainActor = { admin: true, id: "admin" }
const app = { relayId, resourceId: appId, resourceType: "app" } as const

// Work on a whole resource, as moving or deleting it is.
const wholeResource = quickOperation<WebHostnameResource>({
  kind: "test.move",
  locks: (resource) => [
    exclusive(
      `${resource.resourceType}:${resource.relayId}/${resource.resourceId}`
    ),
  ],
  version: 1,
})

interface FakeRecord {
  comment?: string
  content: string
  name: string
  type: string
  zoneId: string
}

// Cloudflare is the external system: zones, each a set of DNS records by ID.
function fakeCloudflare(zones: Array<{ id: string; name: string }>) {
  const records = new Map<string, FakeRecord>()
  // Methods whose next request Cloudflare fails, as an outage would.
  const failing = new Set<string>()
  // Methods whose next request waits until the test lets it through.
  const holds = new Map<
    string,
    { reached: () => void; released: Promise<void> }
  >()
  let nextId = 0
  const success = (result: unknown) =>
    Response.json({ errors: [], result, success: true })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      const hold = holds.get(method)
      if (hold) {
        holds.delete(method)
        hold.reached()
        await hold.released
      }
      if (failing.delete(method)) {
        return Response.json(
          { errors: [{ code: 10_000, message: "Service unavailable" }] },
          { status: 503 }
        )
      }
      const [, , , , zoneId, , recordId] = url.pathname.split("/")
      if (url.pathname.endsWith("/zones")) {
        return success(zones.map((zone) => ({ ...zone, status: "active" })))
      }
      if (method === "GET") {
        const name = url.searchParams.get("name")
        return success(
          [...records]
            .filter(([, record]) => record.name === name)
            .map(([id, record]) => ({ id, ...record }))
        )
      }
      const create = (body: Omit<FakeRecord, "zoneId">) => {
        nextId += 1
        const id = `record-${nextId}`
        records.set(id, { ...body, zoneId: zoneId ?? "" })
        return { id, name: body.name, type: body.type }
      }
      if (method === "POST" && recordId === "batch") {
        const batch = JSON.parse(String(init?.body)) as {
          deletes: Array<{ id: string }>
          posts: Array<FakeRecord>
        }
        for (const { id } of batch.deletes) records.delete(id)
        return success({ posts: batch.posts.map(create) })
      }
      if (method === "POST")
        return success(create(JSON.parse(String(init?.body))))
      if (method === "DELETE") {
        records.delete(recordId ?? "")
        return success({ id: recordId })
      }
      const body = JSON.parse(String(init?.body)) as FakeRecord
      records.set(recordId ?? "", { ...body, zoneId: zoneId ?? "" })
      return success({ id: recordId, name: body.name, type: body.type })
    })
  )
  return {
    /** `name → content` for every record. */
    dns: () =>
      Object.fromEntries(
        [...records.values()].map((record) => [record.name, record.content])
      ),
    failNext: (method: string) => {
      failing.add(method)
    },
    /** Holds the next `method` request until `release`, once it arrives. */
    hold: (method: string) => {
      let arrive = () => {}
      let release = () => {}
      const reached = new Promise<void>((resolve) => {
        arrive = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(method, { reached: arrive, released })
      return { reached: Effect.promise(() => reached), release }
    },
    /** Deletes a record behind Kiln's back. */
    remove: (name: string) => {
      for (const [id, record] of records)
        if (record.name === name) records.delete(id)
    },
    seed: (record: FakeRecord) => {
      nextId += 1
      records.set(`manual-${nextId}`, record)
    },
  }
}

const insertConnection = (connection: {
  blacklistPatterns?: Array<string>
  id: string
  ownerId: string | null
  vanity?: Array<{ domain: string; zoneId: string; zoneName: string }>
  zones: Array<{ id: string; name: string }>
}) =>
  Effect.gen(function* () {
    yield* insertRows("domain_integration", {
      id: connection.id,
      provider: "cloudflare",
      owner_id: connection.ownerId,
      name: connection.id,
      api_token_ciphertext: encryptWithKeyring(
        `token-${connection.id}`,
        betterAuthSecrets(),
        "kiln-cloudflare-api-token"
      ),
      blacklist_patterns: JSON.stringify(connection.blacklistPatterns ?? []),
      zones: JSON.stringify(connection.zones),
      // Fresh, so a hostname outside its zones doesn't list them again.
      last_verified_at: Date.now(),
      created_at: 0,
      updated_at: 0,
    })
    for (const [index, domain] of (connection.vanity ?? []).entries()) {
      yield* insertRows("domain_zone", {
        domain: domain.domain,
        integration_id: connection.id,
        zone_id: domain.zoneId,
        zone_name: domain.zoneName,
        is_default: index === 0,
        enabled: true,
        created_at: 0,
        updated_at: 0,
      })
    }
  })

const ownerZone = { id: "z".repeat(31) + "1", name: "owner.example" }
const platformZone = { id: "z".repeat(31) + "2", name: "kiln.site" }

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* insertRelay(otherRelayId)
  yield* insertRows("app", {
    app_id: appId,
    relay_id: relayId,
    name: "Shop",
    config_ciphertext: "config",
    created_by: owner.id,
    owner_id: owner.id,
    created_at: 0,
    updated_at: 0,
  })
  yield* insertInstance(relayId, instanceId, { owner_id: owner.id })
  yield* insertConnection({
    id: "owner1",
    ownerId: owner.id,
    zones: [ownerZone],
  })
  yield* insertConnection({
    blacklistPatterns: ["^admin$"],
    id: "cloudflare",
    ownerId: null,
    vanity: [
      {
        domain: "play.kiln.site",
        zoneId: platformZone.id,
        zoneName: platformZone.name,
      },
    ],
    zones: [platformZone],
  })
})

const server = {
  relayId,
  resourceId: instanceId,
  resourceType: "instance",
} as const

// Saving a resource's routes, as its network page does: hostnames are
// claimed before the Relay takes the routes, here `relayWrite`.
const claim = (
  actor: DomainActor,
  hostnames: Array<string>,
  resource: WebHostnameResource = app,
  relayWrite: Effect.Effect<void, string> = Effect.void
) => saveWebRouteHostnamesEffect({ actor, hostnames, resource }, relayWrite)

// And then bringing its DNS records in line.
const save = (
  actor: DomainActor,
  hostnames: Array<string>,
  resource: WebHostnameResource = app
) =>
  claim(actor, hostnames, resource).pipe(
    Effect.andThen(reconcileResourceWebHostnamesEffect(resource))
  )

const refusal = (
  actor: DomainActor,
  hostnames: Array<string>,
  resource: WebHostnameResource = server
) =>
  claim(actor, hostnames, resource).pipe(
    Effect.flip,
    Effect.map((error) => ({
      holder:
        typeof error === "object" && error._tag === "HostnameInUseError"
          ? error.holder
          : null,
      message: typeof error === "string" ? error : error.message,
    }))
  )

const hostnameRows = Effect.map(
  selectRows<{ hostname: string; relay_id: string; status: string }>(
    "web_hostname"
  ),
  (rows) =>
    Object.fromEntries(
      rows.map((row) => [row.hostname, `${row.status}@${row.relay_id.trim()}`])
    )
)

// The DNS worker's pass. Game server addresses it settles are cached for
// lists, which these tests don't read.
const dnsPass = reconcileDueDnsEffect.pipe(
  Effect.provide(
    Layer.succeed(AppCache)({
      backend: "disabled",
      enabled: false,
      get: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      set: () => Effect.void,
    })
  )
)

const claimedNames = Effect.map(
  selectRows<{ hostname: string }>("hostname_claim"),
  (rows) => rows.map((row) => row.hostname).sort()
)

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => disposeAppRuntime())

describeMysql("web route hostnames", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps DNS records in step with an app's routes", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])

        yield* save(owner, ["shop.owner.example"])
        assert.deepEqual(cloudflare.dns(), {
          "shop.owner.example": "relay-one.relay.test",
        })

        yield* save(owner, ["www.owner.example"])
        assert.deepEqual(cloudflare.dns(), {
          "www.owner.example": "relay-one.relay.test",
        })

        yield* save(owner, [])
        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})
        assert.deepEqual(yield* claimedNames, [])
      })
    )

    it.effect("leaves a record Kiln didn't create alone", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        cloudflare.seed({
          content: "198.51.100.7",
          name: "shop.owner.example",
          type: "A",
          zoneId: ownerZone.id,
        })

        yield* save(owner, ["shop.owner.example"])
        assert.deepEqual(yield* hostnameRows, {
          "shop.owner.example": "external@relay-one",
        })

        yield* save(owner, [])
        assert.deepEqual(cloudflare.dns(), {
          "shop.owner.example": "198.51.100.7",
        })
      })
    )

    it.effect("uses an owner's Cloudflare connection only for its owner", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone, platformZone])

        // Someone the owner shares the app with can't publish names in
        // the owner's zones, nor in the platform's beyond its vanity
        // domains, and a name nobody's connection reaches is theirs to
        // point.
        yield* save(collaborator, [
          "login.owner.example",
          "status.kiln.site",
          "deep.name.play.kiln.site",
          "shop.elsewhere.example",
        ])
        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})

        // A name under the platform's vanity domain is anyone's to take.
        yield* save(collaborator, ["shop.play.kiln.site"])
        assert.deepEqual(cloudflare.dns(), {
          "shop.play.kiln.site": "relay-one.relay.test",
        })

        // A platform administrator may use the platform's whole zone.
        yield* save(admin, ["shop.play.kiln.site", "status.kiln.site"])
        assert.deepEqual(cloudflare.dns(), {
          "shop.play.kiln.site": "relay-one.relay.test",
          "status.kiln.site": "relay-one.relay.test",
        })
      })
    )

    it.effect(
      "claims names before a save, refusing another resource's, and reserved or taken ones on others' vanity domains",
      () =>
        Effect.gen(function* () {
          yield* seed
          const gamesZone = { id: "z".repeat(31) + "3", name: "games.example" }
          yield* insertConnection({
            blacklistPatterns: ["^www$"],
            id: "owner2",
            ownerId: owner.id,
            vanity: [
              {
                domain: gamesZone.name,
                zoneId: gamesZone.id,
                zoneName: gamesZone.name,
              },
            ],
            zones: [gamesZone],
          })
          const cloudflare = fakeCloudflare([
            ownerZone,
            platformZone,
            gamesZone,
          ])
          cloudflare.seed({
            content: "198.51.100.7",
            name: "taken.play.kiln.site",
            type: "A",
            zoneId: platformZone.id,
          })
          yield* save(collaborator, ["shop.play.kiln.site"])

          // Whatever its case, the app's name stays the app's.
          assert.deepEqual(yield* refusal(owner, ["SHOP.play.kiln.site"]), {
            holder: app,
            message: "shop.play.kiln.site is already in use",
          })
          assert.deepEqual(
            yield* refusal(collaborator, ["admin.play.kiln.site"]),
            { holder: null, message: "admin.play.kiln.site is reserved" }
          )
          // Kiln never takes over a record it didn't make.
          assert.deepEqual(
            yield* refusal(collaborator, ["taken.play.kiln.site"]),
            { holder: null, message: "taken.play.kiln.site is already in use" }
          )
          // A person's own vanity domain reserves names from others too.
          assert.deepEqual(
            yield* refusal(collaborator, ["www.games.example"]),
            { holder: null, message: "www.games.example is reserved" }
          )
          // A refused save claims none of its names.
          assert.deepEqual(
            yield* refusal(collaborator, [
              "free.play.kiln.site",
              "admin.play.kiln.site",
            ]),
            { holder: null, message: "admin.play.kiln.site is reserved" }
          )
          assert.deepEqual(yield* claimedNames, ["shop.play.kiln.site"])

          // A free name is claimed, as are reserved ones for the domain's
          // owner: the person, or Kiln's administrators.
          yield* claim(owner, ["www.games.example"], server)
          yield* claim(
            collaborator,
            ["www.games.example", "free.play.kiln.site"],
            server
          )
          yield* claim(
            admin,
            [
              "www.games.example",
              "free.play.kiln.site",
              "admin.play.kiln.site",
            ],
            server
          )
          assert.deepEqual(yield* hostnameRows, {
            "admin.play.kiln.site": "pending@relay-one",
            "free.play.kiln.site": "pending@relay-one",
            "shop.play.kiln.site": "active@relay-one",
            "www.games.example": "pending@relay-one",
          })
          // So a second save can't take a claimed name before its routes
          // land.
          assert.deepEqual(
            yield* refusal(collaborator, ["free.play.kiln.site"], app),
            {
              holder: server,
              message: "free.play.kiln.site is already in use",
            }
          )
        })
    )

    it.effect(
      "lets a game server route its own address, and a vanity name's www counterpart",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone, platformZone])
          // The game server's address, whose record Kiln already keeps.
          yield* insertRows("instance_domain", {
            id: "00000000-0000-4000-8000-000000000009",
            relay_id: relayId,
            instance_id: instanceId,
            is_primary: true,
            integration_id: "cloudflare",
            vanity_label: "survival",
            domain: "play.kiln.site",
            public_host: "relay-one.relay.test",
            public_port: 25_565,
            supports_srv: false,
            status: "active",
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("hostname_claim", {
            hostname: "survival.play.kiln.site",
            relay_id: relayId,
            resource_type: "instance",
            resource_id: instanceId,
            created_at: 0,
          })
          cloudflare.seed({
            content: "relay-one.relay.test",
            name: "survival.play.kiln.site",
            type: "CNAME",
            zoneId: platformZone.id,
          })

          yield* save(
            collaborator,
            [
              "survival.play.kiln.site",
              "www.survival.play.kiln.site",
              "map.play.kiln.site",
              "www.map.play.kiln.site",
            ],
            server
          )

          assert.deepEqual(cloudflare.dns(), {
            "map.play.kiln.site": "relay-one.relay.test",
            "survival.play.kiln.site": "relay-one.relay.test",
            "www.map.play.kiln.site": "relay-one.relay.test",
            "www.survival.play.kiln.site": "relay-one.relay.test",
          })
          // Its own address is held for the route too, with no record of
          // its own while the domain keeps one.
          assert.deepEqual(yield* hostnameRows, {
            "map.play.kiln.site": "active@relay-one",
            "survival.play.kiln.site": "active@relay-one",
            "www.map.play.kiln.site": "active@relay-one",
            "www.survival.play.kiln.site": "active@relay-one",
          })
          // A web hostname can't take a game server's address, however
          // it's spelled.
          const taken = yield* insertWebHostnameEffect({
            ...app,
            connectionId: "cloudflare",
            generated: false,
            hostname: "Survival.play.kiln.site",
            id: "00000000-0000-4000-8000-00000000000a",
            vanityDomain: "play.kiln.site",
            zoneId: platformZone.id,
          }).pipe(Effect.flip)
          assert.strictEqual(
            taken.message,
            "survival.play.kiln.site is already in use"
          )
          // Only beside a name the resource holds.
          yield* save(collaborator, ["www.shop.play.kiln.site"])
          assert.strictEqual(
            cloudflare.dns()["www.shop.play.kiln.site"],
            undefined
          )
        })
    )

    it.effect(
      "keeps a route on a game server's address once the address is renamed",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([platformZone])
          cloudflare.seed({
            comment: `Managed by Kiln for server ${instanceId}`,
            content: "relay-one.relay.test",
            name: "survival.play.kiln.site",
            type: "CNAME",
            zoneId: platformZone.id,
          })
          yield* insertRows("instance_domain", {
            id: "00000000-0000-4000-8000-000000000009",
            relay_id: relayId,
            instance_id: instanceId,
            is_primary: true,
            integration_id: "cloudflare",
            vanity_label: "survival",
            domain: "play.kiln.site",
            public_host: "relay-one.relay.test",
            public_port: 25_565,
            supports_srv: false,
            address_record_id: "manual-1",
            address_record_type: "CNAME",
            status: "active",
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("hostname_claim", {
            hostname: "survival.play.kiln.site",
            relay_id: relayId,
            resource_type: "instance",
            resource_id: instanceId,
            created_at: 0,
          })
          yield* save(collaborator, ["survival.play.kiln.site"], server)

          yield* beginInstanceDomainRenameEffect({
            domain: "play.kiln.site",
            id: "00000000-0000-4000-8000-000000000009",
            vanityLabel: "creative",
          })
          yield* dnsPass
          yield* dnsPass

          // The route keeps its name, now with a record of its own.
          assert.deepEqual(cloudflare.dns(), {
            "creative.play.kiln.site": "relay-one.relay.test",
            "survival.play.kiln.site": "relay-one.relay.test",
          })
          assert.deepEqual(yield* claimedNames, [
            "creative.play.kiln.site",
            "survival.play.kiln.site",
          ])
          assert.deepEqual(
            yield* refusal(collaborator, ["survival.play.kiln.site"], app),
            {
              holder: server,
              message: "survival.play.kiln.site is already in use",
            }
          )
        })
    )

    it.effect(
      "holds a failed save's names without records until a save settles them",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone])
          // The Relay may have taken the routes, whatever the error says.
          const failed = yield* claim(
            owner,
            ["shop.owner.example"],
            app,
            Effect.fail("The Relay connection closed")
          ).pipe(Effect.flip)
          yield* reconcileResourceWebHostnamesEffect(app)
          yield* dnsPass

          assert.strictEqual(failed, "The Relay connection closed")
          assert.deepEqual(cloudflare.dns(), {})
          assert.deepEqual(yield* claimedNames, ["shop.owner.example"])

          yield* save(owner, [])
          assert.deepEqual(yield* hostnameRows, {})
          assert.deepEqual(yield* claimedNames, [])
        })
    )

    it.effect("follows the latest save, however late its sync runs", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])

        // A save whose sync hasn't run when the next save replaces its
        // routes: the late sync does what the latest save asked.
        yield* claim(owner, ["one.owner.example"])
        yield* claim(owner, ["two.owner.example"])
        yield* reconcileResourceWebHostnamesEffect(app)
        // Dropped and added back before its record was deleted.
        yield* claim(owner, [])
        yield* claim(owner, ["two.owner.example"])
        yield* reconcileResourceWebHostnamesEffect(app)

        assert.deepEqual(cloudflare.dns(), {
          "two.owner.example": "relay-one.relay.test",
        })
        assert.deepEqual(yield* hostnameRows, {
          "two.owner.example": "active@relay-one",
        })
        assert.deepEqual(yield* claimedNames, ["two.owner.example"])
      })
    )

    it.effect(
      "waits to change a resource's DNS while the whole resource is held, as a move holds it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone])
          yield* claim(owner, ["shop.owner.example"])
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const moving = yield* runOperation(
            wholeResource,
            app,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ).pipe(Effect.forkChild)
          yield* Deferred.await(started)

          const syncing = yield* Effect.forkChild(
            reconcileResourceWebHostnamesEffect(app)
          )
          yield* selectRows<{ kind: string; state: string }>("operation").pipe(
            Effect.repeat({
              until: (rows) =>
                rows.some(
                  (row) =>
                    row.kind === "dns.webRoutes.reconcile" &&
                    row.state === "waiting"
                ),
            })
          )
          assert.deepEqual(cloudflare.dns(), {})

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(moving)
          yield* Fiber.join(syncing)
          assert.deepEqual(cloudflare.dns(), {
            "shop.owner.example": "relay-one.relay.test",
          })
        })
    )

    it.effect("deletes a record made while its Relay was removed", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* claim(owner, ["shop.owner.example"])

        // Its Relay is removed, keeping records, while the sync is making
        // the record: nothing would delete it later.
        const creating = cloudflare.hold("POST")
        const syncing = yield* Effect.forkChild(
          reconcileResourceWebHostnamesEffect(app)
        )
        yield* creating.reached
        yield* removeRelayWebHostnamesEffect(relayId, false)
        creating.release()
        yield* Fiber.join(syncing)

        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})
        assert.deepEqual(yield* claimedNames, [])
      })
    )

    it.effect(
      "keeps a removed Relay's deletes marked whatever a sync under way does",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone])
          yield* claim(owner, ["shop.owner.example"])

          // Its Relay's removal marks it while a sync is making its record.
          const creating = cloudflare.hold("POST")
          const syncing = yield* Effect.forkChild(
            reconcileResourceWebHostnamesEffect(app)
          )
          yield* creating.reached
          yield* markRelayWebHostnamesRemovingEffect(relayId)
          creating.release()
          yield* Fiber.join(syncing)

          assert.deepEqual(yield* hostnameRows, {
            "shop.owner.example": "removing@relay-one",
          })
          yield* dnsPass
          assert.deepEqual(cloudflare.dns(), {})
          assert.deepEqual(yield* claimedNames, [])
        })
    )

    it.effect("deletes a removed Relay's records a route save revived", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["shop.owner.example"])

        // The Relay is removed while a save of the same routes is writing
        // them; the save finishes after the removal marked its hostnames.
        const writing = yield* Deferred.make<void>()
        const saving = yield* Effect.forkChild(
          saveWebRouteHostnamesEffect(
            { actor: owner, hostnames: ["shop.owner.example"], resource: app },
            Deferred.await(writing)
          )
        )
        const removing = yield* Effect.forkChild(
          removeRelayWebHostnamesEffect(relayId, true)
        )
        while (
          (yield* hostnameRows)["shop.owner.example"] !== "removing@relay-one"
        ) {
          yield* Effect.yieldNow
        }
        yield* Deferred.succeed(writing, undefined)
        yield* Fiber.join(saving)
        yield* Fiber.join(removing)

        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})
        assert.deepEqual(yield* claimedNames, [])
      })
    )

    it.effect(
      "refuses a name another resource claims while it checks Cloudflare",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone, platformZone])
          const checking = cloudflare.hold("GET")
          const claiming = yield* Effect.forkChild(
            refusal(collaborator, ["race.play.kiln.site"], server)
          )
          yield* checking.reached
          yield* claim(collaborator, ["race.play.kiln.site"], app)
          checking.release()

          assert.deepEqual(yield* Fiber.join(claiming), {
            holder: app,
            message: "race.play.kiln.site is already in use",
          })
          assert.deepEqual(yield* hostnameRows, {
            "race.play.kiln.site": "pending@relay-one",
          })
        })
    )

    it.effect(
      "finds records whose answers were lost, also once their game server moved",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone])
          const lostRecord = (name: string, id: string, owner: string) =>
            cloudflare.seed({
              comment: `Managed by Kiln for ${owner} (kiln:${id})`,
              content: "relay-one.relay.test",
              name,
              type: "CNAME",
              zoneId: ownerZone.id,
            })
          // A create that never heard back, and then the game server moved.
          yield* claim(owner, ["lost.owner.example"], server)
          const [lost] = yield* listWebHostnamesEffect()
          lostRecord(
            "lost.owner.example",
            lost!.id,
            `a web route of server ${instanceId}`
          )
          const moved = {
            relayId: otherRelayId,
            resourceId: "c".repeat(40),
            resourceType: "instance",
          } as const
          yield* moveResourceWebHostnamesEffect(server, moved)
          assert.deepEqual(cloudflare.dns(), {
            "lost.owner.example": "relay-two.relay.test",
          })

          // A replacement that never heard back: the row still names the
          // record it replaced.
          yield* save(owner, ["swap.owner.example"])
          const swap = (yield* listWebHostnamesEffect()).find(
            (row) => row.hostname === "swap.owner.example"
          )
          cloudflare.remove("swap.owner.example")
          lostRecord("swap.owner.example", swap!.id, `app ${appId}`)

          yield* save(owner, [])
          yield* save(owner, [], moved)

          assert.deepEqual(cloudflare.dns(), {})
          assert.deepEqual(yield* claimedNames, [])
        })
    )

    it.effect(
      "only deletes an app's generated address while no route uses it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone, platformZone])
          const address = yield* generateAppHostnameEffect(app)
          yield* save(collaborator, ["shop.play.kiln.site", address!])
          const rows = yield* listWebHostnamesEffect()
          const release = (hostname: string) =>
            releaseWebHostnameEffect(
              rows.find((row) => row.hostname === hostname)!
            )

          assert.strictEqual(
            (yield* Effect.flip(release(address!))).message,
            `A web route uses ${address}. Remove it from the routes first.`
          )
          assert.strictEqual(
            (yield* Effect.flip(release("shop.play.kiln.site"))).message,
            "Remove the web route to delete shop.play.kiln.site"
          )

          yield* save(collaborator, ["shop.play.kiln.site"])
          yield* release(address!)
          assert.deepEqual(Object.keys(cloudflare.dns()), [
            "shop.play.kiln.site",
          ])
        })
    )

    it.effect(
      "moves a name a game server's domain and route share with the domain",
      () =>
        Effect.gen(function* () {
          yield* seed
          fakeCloudflare([platformZone])
          yield* insertRows("instance_domain", {
            id: "00000000-0000-4000-8000-000000000009",
            relay_id: relayId,
            instance_id: instanceId,
            is_primary: true,
            integration_id: "cloudflare",
            vanity_label: "survival",
            domain: "play.kiln.site",
            public_host: "relay-one.relay.test",
            public_port: 25_565,
            supports_srv: false,
            status: "active",
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("hostname_claim", {
            hostname: "survival.play.kiln.site",
            relay_id: relayId,
            resource_type: "instance",
            resource_id: instanceId,
            created_at: 0,
          })
          yield* save(
            collaborator,
            ["survival.play.kiln.site", "map.play.kiln.site"],
            server
          )
          const moved = {
            relayId: otherRelayId,
            resourceId: "c".repeat(40),
            resourceType: "instance",
          } as const

          // Routes alone leave it with the domain.
          yield* moveResourceWebHostnamesEffect(server, moved)
          assert.deepEqual(yield* hostnameRows, {
            "map.play.kiln.site": "active@relay-two",
            "survival.play.kiln.site": "active@relay-one",
          })
          // The domain takes it along.
          yield* reassignInstanceDomainsEffect(
            { instanceId, relayId },
            { instanceId: moved.resourceId, relayId: otherRelayId }
          )
          assert.deepEqual(
            (yield* selectRows<{ hostname: string; relay_id: string }>(
              "hostname_claim"
            ))
              .map((row) => `${row.hostname}@${row.relay_id.trim()}`)
              .sort(),
            [
              "map.play.kiln.site@relay-two",
              "survival.play.kiln.site@relay-two",
            ]
          )
          assert.deepEqual(yield* hostnameRows, {
            "map.play.kiln.site": "active@relay-two",
            "survival.play.kiln.site": "active@relay-two",
          })
        })
    )

    it.effect("finishes deleting an app's records when one delete fails", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["one.owner.example", "two.owner.example"])

        cloudflare.failNext("DELETE")
        yield* deleteResourceWebHostnamesEffect(app).pipe(Effect.flip)
        assert.strictEqual(Object.keys(cloudflare.dns()).length, 1)

        yield* TestClock.adjust("31 seconds")
        yield* dnsPass
        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})
        assert.deepEqual(yield* claimedNames, [])
      })
    )

    it.effect("keeps a connection while a web route's hostname uses it", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["shop.owner.example"])
        const refusal =
          "A web route or app address uses this connection. Remove it first"

        // Disconnecting would let go of a name its route still serves.
        assert.strictEqual(
          (yield* Effect.flip(requireConnectionUnusedEffect("owner1"))).message,
          refusal
        )
        // Also when it's added after that check.
        assert.strictEqual(
          (yield* Effect.flip(deleteDomainConnectionEffect("owner1"))).message,
          refusal
        )
        assert.deepEqual(Object.keys(cloudflare.dns()), ["shop.owner.example"])
        assert.deepEqual(yield* claimedNames, ["shop.owner.example"])

        yield* save(owner, [])
        yield* deleteDomainConnectionEffect("owner1")
      })
    )

    it.effect("makes a record deleted in Cloudflare again on Sync", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["shop.owner.example"])
        cloudflare.remove("shop.owner.example")

        yield* resyncWebHostnamesEffect(() => true)

        assert.deepEqual(cloudflare.dns(), {
          "shop.owner.example": "relay-one.relay.test",
        })
      })
    )

    it.effect(
      "finishes DNS work left undone once its retry is due, taking up a record whose answer was lost",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone])
          yield* save(owner, ["old.owner.example"])

          // Hearth stopped after Cloudflare made a record but before it
          // heard back, and a delete failed in an outage.
          yield* claim(owner, ["new.owner.example"])
          const lost = (yield* listWebHostnamesEffect()).find(
            (row) => row.hostname === "new.owner.example"
          )
          cloudflare.seed({
            comment: `Managed by Kiln for app ${appId} (kiln:${lost!.id})`,
            content: "relay-one.relay.test",
            name: "new.owner.example",
            type: "CNAME",
            zoneId: ownerZone.id,
          })
          cloudflare.failNext("DELETE")
          yield* dnsPass
          assert.deepEqual(cloudflare.dns(), {
            "new.owner.example": "relay-one.relay.test",
            "old.owner.example": "relay-one.relay.test",
          })
          assert.deepEqual(yield* hostnameRows, {
            "new.owner.example": "active@relay-one",
            "old.owner.example": "removing@relay-one",
          })

          // The delete waits for its retry, and keeps its name until then.
          yield* dnsPass
          assert.deepEqual(yield* claimedNames, [
            "new.owner.example",
            "old.owner.example",
          ])
          yield* TestClock.adjust("31 seconds")
          yield* dnsPass

          assert.deepEqual(cloudflare.dns(), {
            "new.owner.example": "relay-one.relay.test",
          })
          assert.deepEqual(yield* claimedNames, ["new.owner.example"])
        })
    )

    it.effect("keeps its record through a Cloudflare outage", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["shop.owner.example"])

        // The move's update fails, so the record stays Kiln's to retry.
        cloudflare.failNext("PATCH")
        yield* moveResourceWebHostnamesEffect(app, {
          ...app,
          relayId: otherRelayId,
        })
        assert.deepEqual(yield* hostnameRows, {
          "shop.owner.example": "error@relay-two",
        })

        // And removing the route deletes it.
        yield* save(owner, [], { ...app, relayId: otherRelayId })
        assert.deepEqual(cloudflare.dns(), {})
      })
    )

    it.effect("points a moved game server's hostnames at its new Relay", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        yield* save(owner, ["map.owner.example"], server)

        yield* moveResourceWebHostnamesEffect(server, {
          relayId: otherRelayId,
          resourceId: "c".repeat(40),
          resourceType: "instance",
        })

        assert.deepEqual(cloudflare.dns(), {
          "map.owner.example": "relay-two.relay.test",
        })
        assert.deepEqual(yield* hostnameRows, {
          "map.owner.example": "active@relay-two",
        })
      })
    )

    it.effect(
      "gives a new app an address under its owner's vanity domain, else the platform's",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone, platformZone])

          const platformAddress = yield* generateAppHostnameEffect(app)
          assert.match(platformAddress ?? "", /^[a-z0-9-]+\.play\.kiln\.site$/u)

          yield* insertRows("domain_zone", {
            domain: "apps.owner.example",
            integration_id: "owner1",
            zone_id: ownerZone.id,
            zone_name: ownerZone.name,
            is_default: true,
            enabled: true,
            created_at: 0,
            updated_at: 0,
          })
          const ownAddress = yield* generateAppHostnameEffect(app)
          assert.match(ownAddress ?? "", /^[a-z0-9-]+\.apps\.owner\.example$/u)
          assert.deepEqual(
            new Set(Object.keys(cloudflare.dns())),
            new Set([ownAddress, platformAddress])
          )

          // The generated address stays without a route.
          yield* save(owner, [])
          assert.strictEqual(Object.keys(cloudflare.dns()).length, 2)
        })
    )
  })
})
