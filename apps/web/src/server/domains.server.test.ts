import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

import { AppCache } from "@/effect/cache"
import type {
  CloudflareIntegrationCredential,
  InstanceDomainAssignment,
} from "@/effect/domains"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"
import { betterAuthSecrets } from "@/lib/environment"
import {
  insertInstanceDomainAssignmentEffect,
  saveCloudflareIntegrationEffect,
} from "@/effect/domains"
import { finalizeInstanceDeletionEffect } from "@/server/instance-deletion-cleanup"

import { encryptWithKeyring } from "../../keyring.mjs"

import {
  applyManagedDomainAddressesEffect,
  deleteInstanceDomainEffect,
  deleteManagedDomainAssignmentEffect,
  loadManagedDomainAddressesEffect,
  provisionInstanceDomain,
  removeInstanceDomainEffect,
  removeRelayManagedDomainsEffect,
} from "./domains.server"

const relayId = "relay-one"
const instanceId = "b".repeat(40)
const aliasId = "00000000-0000-4000-8000-00000000a11a"

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

function memoryCache() {
  const values = new Map<string, string>()
  return Layer.succeed(AppCache)({
    backend: "redis-protocol",
    enabled: true,
    get: (key) => Effect.succeed(values.get(key)),
    remove: (key) =>
      Effect.sync(() => {
        values.delete(key)
      }),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value)
      }),
  })
}

const insertAssignment = (assignment: InstanceDomainAssignment) =>
  insertRows("instance_domain", {
    id: assignment.id,
    is_primary: assignment.primary,
    relay_id: assignment.relayId,
    instance_id: assignment.instanceId,
    integration_id: assignment.integrationId,
    vanity_label: assignment.vanityLabel,
    domain: assignment.domain,
    public_host: assignment.publicHost,
    public_port: assignment.publicPort,
    supports_srv: assignment.supportsSrv,
    srv_service: assignment.srvService,
    srv_protocol: assignment.srvProtocol,
    address_record_id: assignment.addressRecordId,
    address_record_type: assignment.addressRecordType,
    srv_record_id: assignment.srvRecordId,
    status: assignment.status,
    created_at: 0,
    updated_at: 0,
  })

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const insertCredential = (
  options: {
    disabled?: Array<string>
    domains?: Array<string>
    strategy?: "balanced" | "default" | "random"
  } = {}
) =>
  Effect.gen(function* () {
    yield* insertRows("domain_integration", {
      id: "cloudflare",
      provider: "cloudflare",
      api_token_ciphertext: encryptWithKeyring(
        "api-token",
        betterAuthSecrets(),
        "kiln-cloudflare-api-token"
      ),
      assignment_strategy: options.strategy ?? "default",
      blacklist_patterns: "[]",
      enabled: true,
      created_at: 0,
      updated_at: 0,
    })
    const domains = options.domains ?? ["kiln.site"]
    yield* insertRows(
      "domain_zone",
      domains.map((domain, index) => ({
        domain,
        integration_id: "cloudflare",
        zone_id: index === 0 ? "zone-id" : `zone-${index}`,
        zone_name: domain,
        is_default: index === 0,
        enabled: !options.disabled?.includes(domain),
        created_at: 0,
        updated_at: 0,
      }))
    )
  })

const assignmentRows = selectRows<{
  domain: string
  id: string
  is_primary: number
  vanity_label: string
}>("instance_domain")

const assignmentStatuses = Effect.map(
  selectRows<{ status: string }>("instance_domain"),
  (rows) => rows.map((row) => row.status)
)

const optOutKeys = Effect.map(
  selectRows<{ relay_id: string; instance_id: string }>(
    "instance_domain_opt_out"
  ),
  (rows) => rows.map((row) => `${row.relay_id}:${row.instance_id}`)
)

const assignmentKeys = Effect.map(
  selectRows<{ relay_id: string; instance_id: string }>("instance_domain"),
  (rows) => rows.map((row) => `${row.relay_id}:${row.instance_id}`)
)

// Cloudflare is the external system: a DNS zone holding the given records
// (by ID) that can be down, or refuse to delete particular records.
function fakeCloudflare(
  options: { down?: boolean; records?: Array<string> } = {}
) {
  const records = new Map<string, string>(
    (options.records ?? []).map((id) => [id, `${id}.kiln.site`])
  )
  const refuseDelete = new Set<string>()
  let nextId = 0
  const failure = (status: number, code?: number) =>
    Response.json(
      { errors: [{ code, message: "Cloudflare is unavailable" }], success: false },
      { status }
    )
  const success = (result: unknown) =>
    Response.json({ errors: [], result, success: true })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (options.down) return failure(503)
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      if (method === "GET") {
        const name = url.searchParams.get("name")
        return success(
          [...records]
            .filter(([, recordName]) => recordName === name)
            .map(([id, recordName]) => ({ id, name: recordName, type: "A" }))
        )
      }
      const create = (record: { name: string; type: string }) => {
        nextId += 1
        const id = `record-${nextId}`
        records.set(id, record.name)
        return { id, name: record.name, type: record.type }
      }
      if (method === "POST" && url.pathname.endsWith("/batch")) {
        const batch = JSON.parse(String(init?.body)) as {
          deletes: Array<{ id: string }>
          posts: Array<{ name: string; type: string }>
        }
        for (const { id } of batch.deletes) records.delete(id)
        return success({ posts: batch.posts.map(create) })
      }
      if (method === "POST") {
        return success(create(JSON.parse(String(init?.body))))
      }
      const id = url.pathname.split("/").at(-1) ?? ""
      if (method === "DELETE") {
        if (refuseDelete.has(id)) return failure(503)
        if (!records.delete(id)) return failure(404, 81_044)
        return success({ id })
      }
      const record = JSON.parse(String(init?.body)) as {
        name: string
        type: string
      }
      if (!records.has(id)) return failure(404, 81_044)
      records.set(id, record.name)
      return success({ id, name: record.name, type: record.type })
    })
  )
  return {
    names: () => [...records.values()].sort(),
    records: () => [...records.keys()].sort(),
    refuseDelete,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => disposeAppRuntime())

describeMysql("managed domain addresses", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "serves cached addresses, including an empty map, until an assignment change invalidates them",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase

          assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {})
          yield* insertAssignment(testAssignment())
          assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {})

          yield* removeRelayManagedDomainsEffect("another-relay", false)

          assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {
            [`${relayId}:${instanceId}`]: {
              address: "play.kiln.site",
              publicHost: "203.0.113.10",
              publicPort: 25_565,
            },
          })
        }).pipe(Effect.provide(memoryCache()))
    )

    it.effect("does not overlay a vanity address onto a changed endpoint", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertAssignment({
          ...testAssignment(),
          publicHost: "old-relay.example.com",
          publicPort: 32_001,
          supportsSrv: false,
          vanityLabel: "vanity",
        })
        const instance = testInstance()

        const [routed] = yield* applyManagedDomainAddressesEffect([instance])
        assert.strictEqual(routed?.connectAddress, instance.connectAddress)

        const [matched] = yield* applyManagedDomainAddressesEffect([
          {
            ...instance,
            connectAddress: "old-relay.example.com:32001",
            publicHost: "old-relay.example.com",
            publicPort: 32_001,
          },
        ])
        assert.strictEqual(matched?.connectAddress, "vanity.kiln.site:32001")
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("managed domain deletion", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "clears only the Relay's Hearth assignments when Cloudflare cleanup is skipped",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const dns = fakeCloudflare({
            records: ["address-record", "srv-record"],
          })
          yield* insertAssignment(testAssignment())
          yield* insertAssignment({
            ...testAssignment(),
            id: aliasId,
            relayId: "another-relay",
            vanityLabel: "other",
          })

          const removed = yield* removeRelayManagedDomainsEffect(relayId, false)

          assert.strictEqual(removed, 1)
          assert.deepEqual(yield* assignmentKeys, [
            `another-relay:${instanceId}`,
          ])
          assert.deepEqual(dns.records(), ["address-record", "srv-record"])
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("removes Cloudflare records and releases the assignment", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare({
          records: ["address-record", "srv-record"],
        })
        yield* insertAssignment(testAssignment())

        yield* deleteManagedDomainAssignmentEffect(
          testAssignment(),
          testCredential()
        )

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("keeps the assignment reserved when DNS teardown fails", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare({ down: true })
        yield* insertAssignment(testAssignment())

        const failure = yield* deleteManagedDomainAssignmentEffect(
          testAssignment(),
          testCredential()
        ).pipe(Effect.flip)

        assert.strictEqual(failure._tag, "ExternalServiceError")
        assert.deepEqual(yield* assignmentKeys, [`${relayId}:${instanceId}`])
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("removing a game server's domain", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps it removed when the game server starts again", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare()
        yield* insertCredential()
        const provision = Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )
        yield* provision
        assert.deepEqual(dns.records(), ["record-1"])

        const [provisioned] = yield* assignmentRows
        yield* removeInstanceDomainEffect(relayId, instanceId, provisioned!.id)
        yield* provision

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("lets a half-finished removal be completed by deleting again", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare({
          records: ["address-record", "srv-record"],
        })
        dns.refuseDelete.add("srv-record")
        yield* insertCredential()
        yield* insertAssignment(testAssignment())

        const failure = yield* removeInstanceDomainEffect(
          relayId,
          instanceId,
          testAssignment().id
        ).pipe(Effect.flip)

        assert.strictEqual(failure._tag, "ExternalServiceError")
        assert.deepEqual(dns.records(), ["srv-record"])
        assert.deepEqual(yield* assignmentStatuses, ["removing"])
        assert.deepEqual(yield* optOutKeys, [`${relayId}:${instanceId}`])

        // A start or Sync before the retry doesn't bring the address back.
        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )
        assert.deepEqual(dns.records(), ["srv-record"])
        assert.deepEqual(yield* assignmentStatuses, ["removing"])

        dns.refuseDelete.clear()
        yield* removeInstanceDomainEffect(
          relayId,
          instanceId,
          testAssignment().id
        )

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect(
      "keeps a domain added after a removal in step with the game server",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          fakeCloudflare({ records: ["address-record", "srv-record"] })
          yield* insertCredential()
          // Its last domain was removed, then a new one was added and fixed
          // by hand, which leaves the removal on record.
          yield* insertRows("instance_domain_opt_out", {
            relay_id: relayId,
            instance_id: instanceId,
            created_at: 0,
          })
          yield* insertAssignment(testAssignment())

          yield* Effect.promise(() =>
            provisionInstanceDomain(testInstance(), relayId)
          )

          const [row] = yield* selectRows<{ public_host: string }>(
            "instance_domain"
          )
          assert.strictEqual(row?.public_host, "new-relay.example.com")
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect(
      "retries a failed replacement while leaving a failed delete alone",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const dns = fakeCloudflare({ records: ["address-record"] })
          dns.refuseDelete.add("address-record")
          yield* insertCredential()
          yield* insertAssignment({ ...testAssignment(), srvRecordId: null })
          // Its last domain's delete half-failed, then a replacement added by
          // hand failed before Cloudflare had any records for it.
          yield* removeInstanceDomainEffect(
            relayId,
            instanceId,
            testAssignment().id
          ).pipe(Effect.flip)
          yield* insertAssignment({
            ...testAlias(),
            addressRecordId: null,
            status: "error",
          })

          yield* Effect.promise(() =>
            provisionInstanceDomain(testInstance(), relayId)
          )

          const rows = yield* selectRows<{ id: string; status: string }>(
            "instance_domain"
          )
          const statuses = new Map(rows.map((row) => [row.id, row.status]))
          assert.strictEqual(statuses.get(testAssignment().id), "removing")
          assert.strictEqual(statuses.get(aliasId), "active")
          assert.include(dns.names(), "alias.kiln.site")
          assert.notInclude(dns.names(), "play.kiln.site")
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("keeps the removal until the game server is gone", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare({ records: ["address-record", "srv-record"] })
        yield* insertCredential()
        yield* insertAssignment(testAssignment())
        yield* removeInstanceDomainEffect(
          relayId,
          instanceId,
          testAssignment().id
        )

        // Deletion clears the domain before asking the Relay, which may
        // refuse and leave the game server running.
        yield* deleteInstanceDomainEffect(relayId, instanceId)
        assert.deepEqual(yield* optOutKeys, [`${relayId}:${instanceId}`])

        yield* finalizeInstanceDeletionEffect(relayId, instanceId)
        assert.deepEqual(yield* optOutKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("reprovisioning a failed domain", () => {
  layer(TestDatabase)((it) => {
    it.effect("deletes the records a failed attempt left behind", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare({ records: ["address-record"] })
        yield* insertCredential()
        yield* insertAssignment({
          ...testAssignment(),
          srvRecordId: null,
          status: "error",
        })

        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )

        assert.deepEqual(dns.records(), ["record-1"])
        assert.deepEqual(yield* assignmentStatuses, ["active"])
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("a game server with several domains", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps its other domains when the primary is removed, promoting one",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const dns = fakeCloudflare({
            records: ["address-record", "srv-record", "alias-record"],
          })
          yield* insertCredential()
          yield* insertAssignment(testAssignment())
          yield* insertAssignment(testAlias())

          yield* removeInstanceDomainEffect(
            relayId,
            instanceId,
            testAssignment().id
          )

          assert.deepEqual(dns.records(), ["alias-record"])
          assert.deepEqual(
            (yield* assignmentRows).map((row) => [row.id, row.is_primary]),
            [[aliasId, 1]]
          )
          // Still has a domain, so starts and Sync keep managing it.
          assert.deepEqual(yield* optOutKeys, [])
          assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {
            [`${relayId}:${instanceId}`]: {
              address: "alias.kiln.site:25565",
              publicHost: "203.0.113.10",
              publicPort: 25_565,
            },
          })
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("advertises the primary domain as its connect address", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        // Created first, so only the primary flag can put the other ahead.
        yield* insertAssignment(testAlias())
        yield* insertAssignment(testAssignment())

        assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {
          [`${relayId}:${instanceId}`]: {
            address: "play.kiln.site",
            publicHost: "203.0.113.10",
            publicPort: 25_565,
          },
        })
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("moves every domain to the game server's new endpoint", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare({
          records: ["address-record", "srv-record", "alias-record"],
        })
        yield* insertCredential()
        yield* insertAssignment(testAssignment())
        yield* insertAssignment(testAlias())

        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )

        const rows = yield* selectRows<{ public_host: string }>(
          "instance_domain"
        )
        assert.deepEqual(
          rows.map((row) => row.public_host),
          ["new-relay.example.com", "new-relay.example.com"]
        )
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("keeps a domain whose delete failed from coming back", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare({
          records: ["address-record", "srv-record", "alias-record"],
        })
        dns.refuseDelete.add("alias-record")
        yield* insertCredential()
        yield* insertAssignment(testAssignment())
        yield* insertAssignment(testAlias())

        yield* removeInstanceDomainEffect(relayId, instanceId, aliasId).pipe(
          Effect.flip
        )
        // The game server keeps its primary, so starts and Sync still run.
        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )

        const rows = yield* selectRows<{ id: string; status: string }>(
          "instance_domain"
        )
        assert.strictEqual(
          rows.find((row) => row.id === aliasId)?.status,
          "removing"
        )
        assert.notInclude(dns.names(), "alias.kiln.site")

        dns.refuseDelete.clear()
        yield* removeInstanceDomainEffect(relayId, instanceId, aliasId)
        assert.deepEqual(yield* assignmentKeys, [`${relayId}:${instanceId}`])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("moves its other domains when one of them fails", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        // The primary's address record was deleted in Cloudflare by hand.
        fakeCloudflare({ records: ["srv-record", "alias-record"] })
        yield* insertCredential()
        yield* insertAssignment({
          ...testAssignment(),
          addressRecordType: "CNAME",
        })
        yield* insertAssignment({ ...testAlias(), addressRecordType: "CNAME" })

        const exit = yield* Effect.exit(
          Effect.promise(() => provisionInstanceDomain(testInstance(), relayId))
        )

        assert.isTrue(exit._tag === "Failure")
        const rows = yield* selectRows<{ id: string; public_host: string }>(
          "instance_domain"
        )
        assert.strictEqual(
          rows.find((row) => row.id === aliasId)?.public_host,
          "new-relay.example.com"
        )
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("deletes every domain when the game server is deleted", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const dns = fakeCloudflare({
          records: ["address-record", "srv-record", "alias-record"],
        })
        yield* insertCredential()
        yield* insertAssignment(testAssignment())
        yield* insertAssignment(testAlias())

        yield* deleteInstanceDomainEffect(relayId, instanceId)

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("choosing a new game server's domain", () => {
  layer(TestDatabase)((it) => {
    it.effect("spreads new game servers to the least used domain", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare()
        yield* insertCredential({
          domains: ["kiln.site", "other.site"],
          strategy: "balanced",
        })
        yield* insertAssignment({
          ...testAssignment(),
          instanceId: "c".repeat(40),
        })

        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )

        const rows = yield* selectRows<{ domain: string; instance_id: string }>(
          "instance_domain"
        )
        assert.deepEqual(
          rows.find((row) => row.instance_id === instanceId)?.domain,
          "other.site"
        )
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect(
      "keeps new game servers off a disabled domain while its domains still sync",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          fakeCloudflare({ records: ["address-record", "srv-record"] })
          yield* insertCredential({
            disabled: ["other.site"],
            domains: ["kiln.site", "other.site"],
            strategy: "balanced",
          })
          // other.site is the least used, but disabled.
          yield* insertAssignment({
            ...testAssignment(),
            id: aliasId,
            instanceId: "c".repeat(40),
          })
          yield* insertAssignment({
            ...testAssignment(),
            domain: "other.site",
            instanceId: "d".repeat(40),
          })
          const otherServer = {
            ...testInstance(),
            id: "d".repeat(40),
          }

          yield* Effect.promise(() =>
            provisionInstanceDomain(testInstance(), relayId)
          )
          yield* Effect.promise(() =>
            provisionInstanceDomain(otherServer, relayId)
          )

          const rows = yield* selectRows<{
            domain: string
            instance_id: string
            public_host: string
          }>("instance_domain")
          const byServer = new Map(rows.map((row) => [row.instance_id, row]))
          assert.strictEqual(byServer.get(instanceId)?.domain, "kiln.site")
          const existing = byServer.get("d".repeat(40))
          assert.strictEqual(existing?.domain, "other.site")
          assert.strictEqual(existing?.public_host, "new-relay.example.com")
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("uses the default domain when told to", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare()
        yield* insertCredential({ domains: ["kiln.site", "other.site"] })
        yield* insertAssignment({
          ...testAssignment(),
          instanceId: "c".repeat(40),
        })

        yield* Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )

        const rows = yield* selectRows<{ domain: string; instance_id: string }>(
          "instance_domain"
        )
        assert.deepEqual(
          rows.find((row) => row.instance_id === instanceId)?.domain,
          "kiln.site"
        )
      }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("saving vanity domains", () => {
  layer(TestDatabase)((it) => {
    const zoneRows = Effect.map(
      selectRows<{ domain: string; enabled: number }>("domain_zone"),
      (rows) =>
        rows
          .map((row) => `${row.domain}:${row.enabled ? "on" : "off"}`)
          .sort()
    )
    const save = (reachableZoneIds: Array<string>) =>
      saveCloudflareIntegrationEffect({
        apiToken: "api-token",
        blacklistPatterns: [],
        domains: [testCredential().domains[0]!],
        enabled: true,
        reachableZoneIds: new Set(reachableZoneIds),
        strategy: "default",
      })

    it.effect(
      "keeps a left-out domain with game server domains, and drops the rest",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertCredential({
            domains: ["kiln.site", "other.site", "spare.site"],
          })
          yield* insertAssignment({ ...testAssignment(), domain: "other.site" })

          yield* save(["zone-id", "zone-1", "zone-2"])

          assert.deepEqual(yield* zoneRows, ["kiln.site:on", "other.site:off"])
          // Disabled, so it takes no new game server domains.
          const refused = yield* insertInstanceDomainAssignmentEffect({
            domain: "other.site",
            id: aliasId,
            instanceId: "c".repeat(40),
            primary: true,
            publicHost: "203.0.113.10",
            publicPort: 25_565,
            relayId,
            srvProtocol: null,
            srvService: null,
            supportsSrv: false,
            vanityLabel: "fresh",
            zoneId: "zone-1",
          }).pipe(Effect.flip)
          assert.strictEqual(refused._tag, "DomainConfigurationError")
        })
    )

    it.effect(
      "refuses a new game server domain in the zone its domain moved from",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertCredential()

          // Loaded before the domain moved zones, so its records would land
          // in the old zone.
          const refused = yield* insertInstanceDomainAssignmentEffect({
            domain: "kiln.site",
            id: aliasId,
            instanceId,
            primary: true,
            publicHost: "203.0.113.10",
            publicPort: 25_565,
            relayId,
            srvProtocol: null,
            srvService: null,
            supportsSrv: false,
            vanityLabel: "fresh",
            zoneId: "previous-zone-id",
          }).pipe(Effect.flip)

          assert.strictEqual(refused._tag, "DomainConfigurationError")
          assert.deepEqual(yield* assignmentKeys, [])
        })
    )

    it.effect(
      "refuses a token that can't reach a domain game servers still use",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertCredential({ domains: ["kiln.site", "other.site"] })
          yield* insertAssignment({ ...testAssignment(), domain: "other.site" })

          const refused = yield* save(["zone-id"]).pipe(Effect.flip)

          assert.strictEqual(refused._tag, "DomainConfigurationError")
          assert.deepEqual(yield* zoneRows, ["kiln.site:on", "other.site:on"])
        })
    )
  })
})

function testInstance() {
  const instance = relayInstanceSchema.parse({
    connectAddress: "new-relay.example.com:32002",
    containerId: "container",
    desiredState: "running",
    directory: "test-server",
    game: "Minecraft",
    id: instanceId,
    implementation: "Paper",
    javaVersion: "21",
    name: "Test server",
    observedState: "running",
    publicHost: "new-relay.example.com",
    publicPort: 32_002,
    service: "test-server",
    shortId: "bbbbbbbb",
    status: "running",
    version: "1.21.11",
  })
  return {
    ...instance,
    relayId,
    relayName: "Relay one",
    relayStatus: "connected" as const,
    routeId: `${relayId}-${instance.shortId}`,
  }
}

function testAssignment(): InstanceDomainAssignment {
  return {
    addressRecordId: "address-record",
    addressRecordType: "A",
    domain: "kiln.site",
    id: "00000000-0000-4000-8000-000000000001",
    instanceId,
    integrationId: "cloudflare",
    lastError: null,
    primary: true,
    publicHost: "203.0.113.10",
    publicPort: 25_565,
    relayId,
    srvProtocol: "tcp",
    srvRecordId: "srv-record",
    srvService: "minecraft",
    status: "active",
    supportsSrv: true,
    vanityLabel: "play",
    zoneId: "zone-id",
  }
}

/** A second domain on the same game server, without an SRV record. */
function testAlias(): InstanceDomainAssignment {
  return {
    ...testAssignment(),
    addressRecordId: "alias-record",
    id: aliasId,
    primary: false,
    srvRecordId: null,
    vanityLabel: "alias",
  }
}

function testCredential(): CloudflareIntegrationCredential {
  return {
    apiToken: "api-token",
    blacklistPatterns: [],
    domains: [
      {
        domain: "kiln.site",
        enabled: true,
        isDefault: true,
        zoneId: "zone-id",
        zoneName: "kiln.site",
      },
    ],
    enabled: true,
    id: "cloudflare",
    lastError: null,
    lastVerifiedAt: null,
    provider: "cloudflare",
    strategy: "default",
  }
}
