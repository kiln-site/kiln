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

const insertCredential = Effect.suspend(() =>
  insertRows("domain_integration", {
    id: "cloudflare",
    provider: "cloudflare",
    domain: "kiln.site",
    zone_id: "zone-id",
    zone_name: "kiln.site",
    api_token_ciphertext: encryptWithKeyring(
      "api-token",
      betterAuthSecrets(),
      "kiln-cloudflare-api-token"
    ),
    blacklist_patterns: "[]",
    enabled: true,
    created_at: 0,
    updated_at: 0,
  })
)

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
      if (method === "POST") {
        const record = JSON.parse(String(init?.body)) as {
          name: string
          type: string
        }
        nextId += 1
        const id = `record-${nextId}`
        records.set(id, record.name)
        return success({ id, name: record.name, type: record.type })
      }
      const id = url.pathname.split("/").at(-1) ?? ""
      if (method === "DELETE") {
        if (refuseDelete.has(id)) return failure(503)
        if (!records.delete(id)) return failure(404, 81_044)
      }
      return success({ id })
    })
  )
  return {
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
        yield* insertCredential
        const provision = Effect.promise(() =>
          provisionInstanceDomain(testInstance(), relayId)
        )
        yield* provision
        assert.deepEqual(dns.records(), ["record-1"])

        yield* removeInstanceDomainEffect(relayId, instanceId)
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
        yield* insertCredential
        yield* insertAssignment(testAssignment())

        const failure = yield* removeInstanceDomainEffect(
          relayId,
          instanceId
        ).pipe(Effect.flip)

        assert.strictEqual(failure._tag, "ExternalServiceError")
        assert.deepEqual(dns.records(), ["srv-record"])
        assert.deepEqual(yield* assignmentStatuses, ["error"])
        assert.deepEqual(yield* optOutKeys, [`${relayId}:${instanceId}`])

        dns.refuseDelete.clear()
        yield* removeInstanceDomainEffect(relayId, instanceId)

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("keeps the removal until the game server is gone", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        fakeCloudflare({ records: ["address-record", "srv-record"] })
        yield* insertCredential
        yield* insertAssignment(testAssignment())
        yield* removeInstanceDomainEffect(relayId, instanceId)

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
        yield* insertCredential
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
    instanceId,
    integrationId: "cloudflare",
    lastError: null,
    publicHost: "203.0.113.10",
    publicPort: 25_565,
    relayId,
    srvProtocol: "tcp",
    srvRecordId: "srv-record",
    srvService: "minecraft",
    status: "active",
    supportsSrv: true,
    vanityLabel: "play",
  }
}

function testCredential(): CloudflareIntegrationCredential {
  return {
    apiToken: "api-token",
    blacklistPatterns: [],
    domain: "kiln.site",
    enabled: true,
    id: "cloudflare",
    lastError: null,
    lastVerifiedAt: null,
    provider: "cloudflare",
    zoneId: "zone-id",
    zoneName: "kiln.site",
  }
}
