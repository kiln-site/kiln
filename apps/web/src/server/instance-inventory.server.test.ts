import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type {
  InstanceInventoryResult,
  InstanceInventoryRequest,
} from "@workspace/contracts"
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
      kind: "server",
      view: request.view,
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
      "enforces the same kind, ID, and Relay grant for every inventory view",
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
          const references = [
            { kind: "server" as const, relayId, id },
            { kind: "server" as const, relayId, id: "b".repeat(40) },
            { kind: "server" as const, relayId: "s".repeat(43), id },
            { kind: "database" as const, relayId, id },
            { kind: "app" as const, relayId, id },
            { kind: "relay" as const, relayId, id: relayId },
          ]
          const requests = references.flatMap((reference) =>
            (["status", "table", "detail"] as const).map((view) => ({
              reference,
              view,
            }))
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
            requests.slice(0, 3)
          )
          assert.strictEqual(
            result.filter((item) => "error" in item).length,
            15
          )
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
          view: "detail",
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
