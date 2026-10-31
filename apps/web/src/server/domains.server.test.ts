import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

import { AppCache } from "@/effect/cache"
import type { InstanceDomainAssignment } from "@/effect/domains"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"
import { betterAuthSecrets } from "@/lib/environment"
import { beginInstanceDomainRenameEffect } from "@/effect/domains"
import { insertWebHostnameEffect } from "@/effect/web-hostnames"

import { encryptWithKeyring } from "../../keyring.mjs"

import {
  provisionInstanceDomain,
  reconcileDueInstanceDomainsEffect,
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

// A domain, and the name it holds.
const insertAssignment = (assignment: InstanceDomainAssignment) =>
  Effect.all([
    insertRows("hostname_claim", {
      hostname: `${assignment.vanityLabel}.${assignment.domain}`,
      relay_id: assignment.relayId,
      resource_type: "instance",
      resource_id: assignment.instanceId,
      created_at: 0,
    }),
    insertDomainRow(assignment),
  ])

const insertDomainRow = (assignment: InstanceDomainAssignment) =>
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
  } = {}
) =>
  Effect.gen(function* () {
    const domains = options.domains ?? ["kiln.site"]
    // The platform's connection, as an install that predates owned ones has.
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
      zones: JSON.stringify(
        domains.map((domain, index) => ({
          id: index === 0 ? "zone-id" : `zone-${index}`,
          name: domain,
        }))
      ),
      created_at: 0,
      updated_at: 0,
    })
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

const claimedNames = Effect.map(
  selectRows<{ hostname: string }>("hostname_claim"),
  (rows) => rows.map((row) => row.hostname).sort()
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
// (by ID) that can refuse to update or delete particular records.
function fakeCloudflare(options: { records?: Array<string> } = {}) {
  const records = new Map<string, string>(
    (options.records ?? []).map((id) => [id, `${id}.kiln.site`])
  )
  // What Kiln noted on each record, by ID.
  const comments = new Map<string, string>()
  const refuseDelete = new Set<string>()
  const refuseUpdate = new Set<string>()
  let nextId = 0
  const failure = (status: number, code?: number) =>
    Response.json(
      {
        errors: [{ code, message: "Cloudflare is unavailable" }],
        success: false,
      },
      { status }
    )
  const success = (result: unknown) =>
    Response.json({ errors: [], result, success: true })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? "GET"
      if (method === "GET") {
        const name = url.searchParams.get("name")
        return success(
          [...records]
            .filter(([, recordName]) => recordName === name)
            .map(([id, recordName]) => ({
              comment: comments.get(id) ?? null,
              id,
              name: recordName,
              type: "A",
            }))
        )
      }
      // Cloudflare refuses a record whose comment is over 100 characters.
      const commentTooLong = (
        writes: ReadonlyArray<{ readonly comment?: string }>
      ) => writes.some((write) => (write.comment?.length ?? 0) > 100)
      const create = (record: {
        comment?: string
        name: string
        type: string
      }) => {
        nextId += 1
        const id = `record-${nextId}`
        records.set(id, record.name)
        if (record.comment) comments.set(id, record.comment)
        return { id, name: record.name, type: record.type }
      }
      if (method === "POST" && url.pathname.endsWith("/batch")) {
        const batch = JSON.parse(String(init?.body)) as {
          deletes: Array<{ id: string }>
          posts: Array<{ comment?: string; name: string; type: string }>
        }
        if (commentTooLong(batch.posts)) return failure(400, 9_100)
        for (const { id } of batch.deletes) records.delete(id)
        return success({ posts: batch.posts.map(create) })
      }
      if (method === "POST") {
        const record = JSON.parse(String(init?.body)) as {
          comment?: string
          name: string
          type: string
        }
        if (commentTooLong([record])) return failure(400, 9_100)
        return success(create(record))
      }
      const id = url.pathname.split("/").at(-1) ?? ""
      if (method === "DELETE") {
        if (refuseDelete.has(id)) return failure(503)
        if (!records.delete(id)) return failure(404, 81_044)
        return success({ id })
      }
      const record = JSON.parse(String(init?.body)) as {
        comment?: string
        name: string
        type: string
      }
      if (!records.has(id)) return failure(404, 81_044)
      if (commentTooLong([record])) return failure(400, 9_100)
      if (refuseUpdate.has(id)) return failure(503)
      records.set(id, record.name)
      return success({ id, name: record.name, type: record.type })
    })
  )
  return {
    names: () => [...records.values()].sort(),
    /** A record Kiln made but never heard back about. */
    lost: (id: string, name: string, comment: string) => {
      records.set(id, name)
      comments.set(id, comment)
    },
    records: () => [...records.keys()].sort(),
    refuseDelete,
    refuseUpdate,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(() => disposeAppRuntime())

describeMysql("renaming a game server's domain", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "holds its old name until Cloudflare has the new one, and finishes a rename cut short",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const dns = fakeCloudflare({
            records: ["address-record", "srv-record"],
          })
          yield* insertCredential()
          yield* insertAssignment(testAssignment())
          const takeOldName = insertWebHostnameEffect({
            connectionId: "cloudflare",
            generated: false,
            hostname: "play.kiln.site",
            id: "00000000-0000-4000-8000-0000000000ac",
            relayId,
            resourceId: "a".repeat(40),
            resourceType: "app",
            vanityDomain: "kiln.site",
            zoneId: "zone-id",
          })

          // Cloudflare refuses to move the records.
          dns.refuseUpdate.add("address-record")
          yield* beginInstanceDomainRenameEffect({
            domain: "kiln.site",
            id: testAssignment().id,
            vanityLabel: "creative",
          })
          yield* reconcileDueInstanceDomainsEffect(0)

          assert.deepEqual(
            (yield* assignmentRows).map((row) => row.vanity_label),
            ["play"]
          )
          assert.deepEqual(yield* claimedNames, [
            "creative.kiln.site",
            "play.kiln.site",
          ])
          assert.strictEqual(
            (yield* Effect.flip(takeOldName)).message,
            "play.kiln.site is already in use"
          )

          // Retried once its wait is up, with Cloudflare back.
          dns.refuseUpdate.clear()
          yield* reconcileDueInstanceDomainsEffect(0)
          assert.deepEqual(yield* claimedNames, [
            "creative.kiln.site",
            "play.kiln.site",
          ])
          yield* reconcileDueInstanceDomainsEffect(31_000)

          assert.deepEqual(dns.names(), [
            "_minecraft._tcp.creative.kiln.site",
            "creative.kiln.site",
          ])
          assert.deepEqual(
            (yield* assignmentRows).map((row) => row.vanity_label),
            ["creative"]
          )
          assert.deepEqual(yield* claimedNames, ["creative.kiln.site"])
          yield* takeOldName
        }).pipe(Effect.provide(disabledCache))
    )
  })
})

describeMysql("removing a game server's domain", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "deletes records a failed attempt never heard back about, whatever removes it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const dns = fakeCloudflare()
          yield* insertCredential()
          const failed = {
            ...testAssignment(),
            addressRecordId: null,
            srvRecordId: null,
            status: "error" as const,
          }
          const lose = (assignmentId: string, name: string) => {
            const comment = `Managed by Kiln for server ${instanceId} (kiln:${assignmentId})`
            dns.lost(`${assignmentId}-address`, `${name}.kiln.site`, comment)
            dns.lost(
              `${assignmentId}-srv`,
              `_minecraft._tcp.${name}.kiln.site`,
              comment
            )
          }
          yield* insertAssignment(failed)
          lose(failed.id, "play")

          yield* removeInstanceDomainEffect(relayId, instanceId, failed.id)
          assert.deepEqual(dns.names(), [])
          assert.deepEqual(yield* claimedNames, [])

          // Removing its Relay with its records too.
          yield* insertAssignment(failed)
          lose(failed.id, "play")
          yield* removeRelayManagedDomainsEffect(relayId, true)
          assert.deepEqual(dns.names(), [])
          assert.deepEqual(yield* claimedNames, [])
        }).pipe(Effect.provide(disabledCache))
    )

    it.effect("lets a half-finished removal be completed later", () =>
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

        // Its name stays held until the delete finishes.
        assert.deepEqual(yield* claimedNames, ["play.kiln.site"])
        dns.refuseDelete.clear()
        yield* reconcileDueInstanceDomainsEffect(0)

        assert.deepEqual(dns.records(), [])
        assert.deepEqual(yield* assignmentKeys, [])
        assert.deepEqual(yield* claimedNames, [])
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
    id: "00000000-0000-4000-8000-000000000001",
    instanceId,
    integrationId: "cloudflare",
    lastError: null,
    next: null,
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
