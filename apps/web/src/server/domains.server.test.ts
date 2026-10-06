import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterEach, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

import { AppCache } from "@/effect/cache"
import type {
  CloudflareIntegrationCredential,
  InstanceDomainAssignment,
} from "@/effect/domains"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

import {
  applyManagedDomainAddressesEffect,
  deleteManagedDomainAssignmentEffect,
  loadManagedDomainAddressesEffect,
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

const assignmentKeys = Effect.map(
  selectRows<{ relay_id: string; instance_id: string }>("instance_domain"),
  (rows) => rows.map((row) => `${row.relay_id}:${row.instance_id}`)
)

// Cloudflare is the external system; record which DNS records it deleted.
function stubCloudflare(status = 200) {
  const deleted: Array<string> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (status !== 200) {
        return Response.json(
          {
            errors: [{ message: "Cloudflare is unavailable" }],
            success: false,
          },
          { status }
        )
      }
      const recordId = String(input).split("/").at(-1) ?? ""
      if (init?.method === "DELETE") deleted.push(recordId)
      return Response.json({
        errors: [],
        result: { id: recordId },
        success: true,
      })
    })
  )
  return deleted
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
          const deleted = stubCloudflare()
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
          assert.deepEqual(deleted, [])
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("removes Cloudflare records and releases the assignment", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const deleted = stubCloudflare()
        yield* insertAssignment(testAssignment())

        yield* deleteManagedDomainAssignmentEffect(
          testAssignment(),
          testCredential()
        )

        assert.sameMembers(deleted, ["address-record", "srv-record"])
        assert.deepEqual(yield* assignmentKeys, [])
      }).pipe(Effect.provide(disabledCache))
    )

    it.effect("keeps the assignment reserved when DNS teardown fails", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        stubCloudflare(503)
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
