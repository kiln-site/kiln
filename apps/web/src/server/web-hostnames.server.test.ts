import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"

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

import type { WebHostnameResource } from "@/effect/web-hostnames"

import type { DomainActor } from "./domain-access.server"
import {
  reconcileResourceWebHostnamesEffect,
  saveWebRouteHostnamesEffect,
} from "./web-hostnames.server"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const relayId = "relay-one"
const appId = "a".repeat(40)
const instanceId = "b".repeat(40)
const owner: DomainActor = { admin: false, id: "owner" }
const collaborator: DomainActor = { admin: false, id: "collaborator" }
const admin: DomainActor = { admin: true, id: "admin" }
const app = { relayId, resourceId: appId, resourceType: "app" } as const

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
      // Cloudflare refuses a record whose comment is over 100 characters.
      const refusesComment = (
        writes: ReadonlyArray<Pick<FakeRecord, "comment">>
      ) =>
        writes.some((write) => (write.comment?.length ?? 0) > 100)
          ? Response.json(
              {
                errors: [
                  {
                    code: 9_100,
                    message:
                      "DNS record comment exceeds the maximum length of 100 characters.",
                  },
                ],
              },
              { status: 400 }
            )
          : null
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
        const refused = refusesComment(batch.posts)
        if (refused) return refused
        for (const { id } of batch.deletes) records.delete(id)
        return success({ posts: batch.posts.map(create) })
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as FakeRecord
        return refusesComment([body]) ?? success(create(body))
      }
      if (method === "DELETE") {
        records.delete(recordId ?? "")
        return success({ id: recordId })
      }
      const body = JSON.parse(String(init?.body)) as FakeRecord
      const refused = refusesComment([body])
      if (refused) return refused
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
  })
})
