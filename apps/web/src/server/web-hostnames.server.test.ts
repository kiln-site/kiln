import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { betterAuthSecrets } from "@/lib/environment"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay, insertRows, selectRows } from "@/test/seed"

import { encryptWithKeyring } from "../../keyring.mjs"

import type { DomainActor } from "./domain-access.server"
import {
  generateAppHostnameEffect,
  moveResourceWebHostnamesEffect,
  syncResourceWebHostnamesEffect,
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

interface FakeRecord {
  content: string
  name: string
  type: string
  zoneId: string
}

// Cloudflare is the external system: zones, each a set of DNS records by ID.
function fakeCloudflare(zones: Array<{ id: string; name: string }>) {
  const records = new Map<string, FakeRecord>()
  let nextId = 0
  const success = (result: unknown) =>
    Response.json({ errors: [], result, success: true })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
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
      if (method === "POST") return success(create(JSON.parse(String(init?.body))))
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
    seed: (record: FakeRecord) => {
      nextId += 1
      records.set(`manual-${nextId}`, record)
    },
  }
}

const insertConnection = (connection: {
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
  yield* insertConnection({ id: "owner1", ownerId: owner.id, zones: [ownerZone] })
  yield* insertConnection({
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
  yield* insertRows("domain_owner_settings", {
    owner_key: "",
    auto_assign: true,
    assignment_strategy: "default",
    blacklist_patterns: JSON.stringify(["^admin$"]),
    created_at: 0,
    updated_at: 0,
  })
})

const sync = (
  actor: DomainActor | null,
  hostnames: Array<string>,
  resource: Parameters<
    typeof syncResourceWebHostnamesEffect
  >[0]["resource"] = app
) => syncResourceWebHostnamesEffect({ actor, hostnames, resource })

const hostnameRows = Effect.map(
  selectRows<{ hostname: string; relay_id: string; status: string }>(
    "web_hostname"
  ),
  (rows) =>
    Object.fromEntries(
      rows.map((row) => [row.hostname, `${row.status}@${row.relay_id.trim()}`])
    )
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

        yield* sync(owner, ["shop.owner.example"])
        assert.deepEqual(cloudflare.dns(), {
          "shop.owner.example": "relay-one.relay.test",
        })

        yield* sync(owner, ["www.owner.example"])
        assert.deepEqual(cloudflare.dns(), {
          "www.owner.example": "relay-one.relay.test",
        })

        yield* sync(owner, [])
        assert.deepEqual(cloudflare.dns(), {})
        assert.deepEqual(yield* hostnameRows, {})
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

        yield* sync(owner, ["shop.owner.example"])
        assert.deepEqual(yield* hostnameRows, {
          "shop.owner.example": "external@relay-one",
        })

        yield* sync(owner, [])
        assert.deepEqual(cloudflare.dns(), {
          "shop.owner.example": "198.51.100.7",
        })
      })
    )

    it.effect(
      "uses an owner's Cloudflare connection only for its owner",
      () =>
        Effect.gen(function* () {
          yield* seed
          const cloudflare = fakeCloudflare([ownerZone, platformZone])

          // Someone the owner shares the app with can't publish names in
          // the owner's zones, nor in the platform's beyond its vanity
          // domains, and a name nobody's connection reaches is theirs to
          // point.
          yield* sync(collaborator, [
            "login.owner.example",
            "status.kiln.site",
            "deep.name.play.kiln.site",
            "shop.elsewhere.example",
          ])
          assert.deepEqual(cloudflare.dns(), {})
          assert.deepEqual(yield* hostnameRows, {})

          // A name under the platform's vanity domain is anyone's to take,
          // unless the platform reserved it.
          yield* sync(collaborator, ["shop.play.kiln.site", "admin.play.kiln.site"])
          assert.deepEqual(cloudflare.dns(), {
            "shop.play.kiln.site": "relay-one.relay.test",
          })

          // A platform administrator may use the platform's whole zone.
          yield* sync(admin, ["shop.play.kiln.site", "status.kiln.site"])
          assert.deepEqual(cloudflare.dns(), {
            "shop.play.kiln.site": "relay-one.relay.test",
            "status.kiln.site": "relay-one.relay.test",
          })
        })
    )

    it.effect("only syncs hostnames it already keeps without a person", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])

        yield* sync(null, ["shop.owner.example"])

        assert.deepEqual(cloudflare.dns(), {})
      })
    )

    it.effect("points a moved game server's hostnames at its new Relay", () =>
      Effect.gen(function* () {
        yield* seed
        const cloudflare = fakeCloudflare([ownerZone])
        const from = {
          relayId,
          resourceId: instanceId,
          resourceType: "instance",
        } as const
        yield* sync(owner, ["map.owner.example"], from)

        yield* moveResourceWebHostnamesEffect(from, {
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
          yield* sync(owner, [])
          assert.strictEqual(Object.keys(cloudflare.dns()).length, 2)
        })
    )
  })
})
