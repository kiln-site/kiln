import { assert, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  InstanceInventoryRequestSchema,
  type InstanceInventoryResult,
  type InstanceInventoryRequest,
} from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  InstanceInventorySource,
  readInstanceInventory,
} from "@/server/instance-inventory.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"
import { ExternalServiceError } from "@/effect/errors"

const relayId = "r".repeat(43),
  id = "a".repeat(40)
const user: AuthenticatedUser = {
  id: "inventory-reader",
  name: "Reader",
  email: "inventory@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}
const values = (
  requests: ReadonlyArray<InstanceInventoryRequest>
): Array<InstanceInventoryResult> =>
  requests.map((request) => ({
    request,
    value: {
      kind: request.reference.kind,
      view: "status",
      data: null,
      observation: {
        ...request.reference,
        inventory: "available",
        reachability: "connected",
        runtime: "running",
        updating: false,
      },
    },
  }))

describeMysql("scoped instance inventory", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "answers only the instances a grant covers, by kind, ID, and Relay",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser(user.id)
          yield* insertRelay(relayId)
          yield* insertRelay("s".repeat(43))
          yield* insertGrant({
            id: "inventory-grant",
            userId: user.id,
            relayId,
            resourceType: "instance",
            resourceId: id,
          })
          yield* insertRows("access_selection", {
            access_id: "inventory-grant",
            selection_kind: "permission",
            selection_key: "instance.read",
          })
          const requests: Array<InstanceInventoryRequest> = [
            { kind: "server" as const, relayId, id },
            { kind: "server" as const, relayId, id: "b".repeat(40) },
            { kind: "server" as const, relayId: "s".repeat(43), id },
            { kind: "database" as const, relayId, id },
            { kind: "app" as const, relayId, id },
            { kind: "relay" as const, relayId, id: relayId },
          ].map(
            (reference) =>
              ({ reference, view: "status" }) as InstanceInventoryRequest
          )
          const result = yield* readInstanceInventory(user, requests).pipe(
            Effect.provideService(InstanceInventorySource, {
              read: (_, requests) => Effect.succeed(values(requests)),
            })
          )
          assert.deepStrictEqual(
            result
              .filter((item) => "value" in item)
              .map((item) => item.request),
            requests.slice(0, 1)
          )
          assert.strictEqual(result.filter((item) => "error" in item).length, 5)
        })
    )

    it.effect(
      "shows a database's members only to those who may read each, and its network",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const readable = "b".repeat(40)
          const member = (
            kind: "app" | "database" | "instance",
            id: string
          ) => ({
            attached: true,
            hostnames: [],
            id,
            kind,
            pendingHostnames: [],
            saved: true,
          })
          const members = [
            member("instance", readable),
            member("instance", "c".repeat(40)),
            member("app", "d".repeat(40)),
            member("database", "e".repeat(40)),
          ]
          yield* insertRelay(relayId)
          const grant = (
            userId: string,
            grantId: string,
            resourceType: "database" | "instance",
            resourceId: string,
            permissions: ReadonlyArray<string>
          ) =>
            Effect.gen(function* () {
              yield* insertGrant({
                id: grantId,
                userId,
                relayId,
                resourceType,
                resourceId,
              })
              yield* insertRows(
                "access_selection",
                permissions.map((permission) => ({
                  access_id: grantId,
                  selection_kind: "permission",
                  selection_key: permission,
                }))
              )
            })
          const networkReader = { ...user, id: "network-reader" }
          const databaseReader = { ...user, id: "database-reader" }
          for (const { id: userId } of [networkReader, databaseReader])
            yield* insertUser(userId)
          yield* grant(networkReader.id, "network", "database", id, [
            "database.read",
            "database.network.read",
          ])
          yield* grant(networkReader.id, "server", "instance", readable, [
            "instance.read",
          ])
          yield* grant(databaseReader.id, "database", "database", id, [
            "database.read",
          ])
          const request: InstanceInventoryRequest = {
            reference: { kind: "database", relayId, id },
            view: "detail",
          }
          const source = {
            read: (
              _: unknown,
              requests: ReadonlyArray<InstanceInventoryRequest>
            ) =>
              Effect.succeed(
                requests.map((request): InstanceInventoryResult => ({
                  request,
                  value: {
                    kind: "database",
                    view: "detail",
                    data: {
                      containerId: "container",
                      createdAt: new Date(0).toISOString(),
                      databaseName: "kiln_main",
                      diskUsedBytes: null,
                      engine: "postgres",
                      hostname: `database-${id}`,
                      id,
                      image: "postgres:17",
                      internalPort: 5432,
                      limits: {
                        cpuMillis: null,
                        diskBytes: null,
                        memoryBytes: null,
                      },
                      members,
                      name: "Main",
                      observedState: "running",
                      shortId: id.slice(0, 8),
                      status: "Ready",
                      supportsImportExport: true,
                    },
                    observation: {
                      ...request.reference,
                      inventory: "available",
                      reachability: "connected",
                      runtime: "running",
                      updating: false,
                    },
                  },
                }))
              ),
          }
          const membersSeenBy = (viewer: AuthenticatedUser) =>
            readInstanceInventory(viewer, [request]).pipe(
              Effect.provideService(InstanceInventorySource, source),
              Effect.map(([result]) =>
                result && "value" in result && result.value.kind === "database"
                  ? result.value.data?.members.map((member) => member.id)
                  : undefined
              )
            )

          assert.deepStrictEqual(yield* membersSeenBy(networkReader), [
            readable,
          ])
          // Without the database's network permission, none.
          assert.deepStrictEqual(yield* membersSeenBy(databaseReader), [])
        })
    )

    it.effect("never answers for a server through its Relay's reference", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        const request = {
          reference: { kind: "relay", relayId, id },
          view: "status",
        } as InstanceInventoryRequest
        const [result] = yield* readInstanceInventory(
          { ...user, isDevelopmentBypass: true },
          [request]
        ).pipe(
          Effect.provideService(InstanceInventorySource, {
            read: (_, requests) => Effect.succeed(values(requests)),
          })
        )
        assert.deepStrictEqual(result, { request, error: "unavailable" })
      })
    )

    it.effect("keeps a healthy Relay's result when another Relay fails", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        yield* insertRelay("s".repeat(43))
        const requests: Array<InstanceInventoryRequest> = [
          relayId,
          "s".repeat(43),
        ].map((relayId) => ({
          reference: { kind: "server", relayId, id },
          view: "status",
        }))
        const result = yield* readInstanceInventory(
          { ...user, isDevelopmentBypass: true },
          requests
        ).pipe(
          Effect.provideService(InstanceInventorySource, {
            read: (relay, requests) =>
              relay.id === relayId
                ? Effect.fail(
                    ExternalServiceError.make({
                      service: "Relay",
                      message: "Disconnected",
                    })
                  )
                : Effect.succeed(values(requests)),
          })
        )
        assert.strictEqual(
          result.some(
            (item) =>
              item.request.reference.relayId === relayId && "error" in item
          ),
          true
        )
        assert.strictEqual(
          result.some(
            (item) =>
              item.request.reference.relayId === "s".repeat(43) &&
              "value" in item
          ),
          true
        )
      })
    )
  })
})

describe("inventory requests", () => {
  const decode = Schema.decodeUnknownExit(InstanceInventoryRequestSchema)
  const request = (kind: string, view: string) => ({
    reference: { kind, relayId, id },
    view,
  })

  // Game server and Relay records carry startup variables and Brick sources,
  // which need stronger permissions than reading status.
  it("accepts only the views each kind serves", () => {
    expect(decode(request("app", "detail"))._tag).toBe("Success")
    expect(decode(request("database", "detail"))._tag).toBe("Success")
    expect(decode(request("server", "status"))._tag).toBe("Success")
    for (const rejected of [
      request("server", "detail"),
      request("server", "table"),
      request("database", "table"),
      { reference: { kind: "relay", relayId, id: relayId }, view: "detail" },
    ])
      expect(decode(rejected)._tag).toBe("Failure")
  })
})
