import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterEach, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"
import type { ResultSetHeader } from "mysql2/promise"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import type {
  CloudflareIntegrationCredential,
  InstanceDomainAssignment,
} from "@/effect/domains"

import {
  applyManagedDomainAddressesEffect,
  deleteManagedDomainAssignmentEffect,
  loadManagedDomainAddressesEffect,
  removeRelayManagedDomainsEffect,
} from "./domains.server"

describe("managed domain address cache", () => {
  it.effect("shares an empty assignment result across Relay polls", () => {
    const values = new Map<string, string>()
    let queries = 0
    const cacheLayer = Layer.succeed(AppCache)({
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
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: () =>
        Effect.sync(() => {
          queries += 1
          return []
        }),
      transaction: () => Effect.die("Unexpected database transaction"),
    })

    return Effect.gen(function* () {
      assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {})
      assert.deepEqual(yield* loadManagedDomainAddressesEffect(), {})
      assert.strictEqual(queries, 1)
    }).pipe(Effect.provide(Layer.merge(cacheLayer, databaseLayer)))
  })

  it.effect("does not overlay a vanity address onto a changed endpoint", () => {
    const relayId = "relay-one"
    const instance = relayInstanceSchema.parse({
      connectAddress: "new-relay.example.com:32002",
      containerId: "container",
      desiredState: "running",
      directory: "test-server",
      game: "Minecraft",
      id: "b".repeat(40),
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
    const values = new Map([
      [
        "domains:assignments:active-addresses",
        JSON.stringify({
          [`${relayId}:${instance.id}`]: {
            address: "vanity.kiln.site:32001",
            publicHost: "old-relay.example.com",
            publicPort: 32_001,
          },
        }),
      ],
    ])
    const cacheLayer = Layer.succeed(AppCache)({
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
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: () => Effect.die("Unexpected database query"),
      transaction: () => Effect.die("Unexpected database transaction"),
    })

    return Effect.gen(function* () {
      const [routed] = yield* applyManagedDomainAddressesEffect([
        {
          ...instance,
          relayId,
          relayName: "Relay one",
          relayStatus: "connected",
          routeId: `${relayId}-${instance.shortId}`,
        },
      ])
      assert.strictEqual(routed?.connectAddress, instance.connectAddress)

      const [matched] = yield* applyManagedDomainAddressesEffect([
        {
          ...instance,
          connectAddress: "old-relay.example.com:32001",
          publicHost: "old-relay.example.com",
          publicPort: 32_001,
          relayId,
          relayName: "Relay one",
          relayStatus: "connected",
          routeId: `${relayId}-${instance.shortId}`,
        },
      ])
      assert.strictEqual(matched?.connectAddress, "vanity.kiln.site:32001")
    }).pipe(Effect.provide(Layer.merge(cacheLayer, databaseLayer)))
  })
})

describe("managed domain deletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect(
    "clears Hearth assignments when Cloudflare cleanup is skipped",
    () => {
      const events: Array<string> = []
      const cacheLayer = Layer.succeed(AppCache)({
        backend: "redis-protocol",
        enabled: true,
        get: () => Effect.succeed(undefined),
        remove: () =>
          Effect.sync(() => {
            events.push("cache:remove")
          }),
        set: () => Effect.void,
      })
      const databaseLayer = Layer.succeed(Database)({
        execute: (operation) =>
          Effect.sync(() => {
            events.push(`database:${operation}`)
            return {} as ResultSetHeader
          }),
        queryRows: () => Effect.succeed([]),
        transaction: () => Effect.die("Unexpected database transaction"),
      })

      return Effect.gen(function* () {
        const removed = yield* removeRelayManagedDomainsEffect(
          "relay-one",
          false
        )

        assert.strictEqual(removed, 0)
        assert.deepEqual(events, [
          "database:domains.assignments.deleteRelay",
          "cache:remove",
        ])
      }).pipe(Effect.provide(Layer.merge(cacheLayer, databaseLayer)))
    }
  )

  it.effect(
    "removes Cloudflare records before releasing the assignment",
    () => {
      const events: Array<string> = []
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        events.push(`cloudflare:${String(input).split("/").at(-1)}`)
        return Response.json({
          errors: [],
          result: { id: String(input).split("/").at(-1) },
          success: true,
        })
      })
      vi.stubGlobal("fetch", fetchMock)
      const cacheLayer = Layer.succeed(AppCache)({
        backend: "redis-protocol",
        enabled: true,
        get: () => Effect.succeed(undefined),
        remove: () =>
          Effect.sync(() => {
            events.push("cache:remove")
          }),
        set: () => Effect.void,
      })
      const databaseLayer = Layer.succeed(Database)({
        execute: (operation) =>
          Effect.sync(() => {
            events.push(`database:${operation}`)
            return {} as ResultSetHeader
          }),
        queryRows: () => Effect.die("Unexpected database query"),
        transaction: () => Effect.die("Unexpected database transaction"),
      })

      return Effect.gen(function* () {
        yield* deleteManagedDomainAssignmentEffect(
          testAssignment(),
          testCredential()
        )

        assert.deepEqual(
          events.slice(0, 2).sort(),
          ["cloudflare:address-record", "cloudflare:srv-record"].sort()
        )
        assert.deepEqual(events.slice(2), [
          "database:domains.assignment.delete",
          "cache:remove",
        ])
      }).pipe(Effect.provide(Layer.merge(cacheLayer, databaseLayer)))
    }
  )

  it.effect("keeps the assignment reserved when DNS teardown fails", () => {
    let databaseWrites = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            errors: [{ message: "Cloudflare is unavailable" }],
            success: false,
          },
          { status: 503 }
        )
      )
    )
    const cacheLayer = Layer.succeed(AppCache)({
      backend: "disabled",
      enabled: false,
      get: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      set: () => Effect.void,
    })
    const databaseLayer = Layer.succeed(Database)({
      execute: () =>
        Effect.sync(() => {
          databaseWrites += 1
          return {} as ResultSetHeader
        }),
      queryRows: () => Effect.die("Unexpected database query"),
      transaction: () => Effect.die("Unexpected database transaction"),
    })

    return Effect.gen(function* () {
      const failure = yield* deleteManagedDomainAssignmentEffect(
        testAssignment(),
        testCredential()
      ).pipe(Effect.flip)

      assert.strictEqual(failure._tag, "ExternalServiceError")
      assert.strictEqual(databaseWrites, 0)
    }).pipe(Effect.provide(Layer.merge(cacheLayer, databaseLayer)))
  })
})

function testAssignment(): InstanceDomainAssignment {
  return {
    addressRecordId: "address-record",
    addressRecordType: "A",
    domain: "kiln.site",
    instanceId: "instance-one",
    integrationId: "cloudflare",
    lastError: null,
    publicHost: "203.0.113.10",
    publicPort: 25_565,
    relayId: "relay-one",
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
