import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

import { adoptCarriedPrimaryRoutes } from "./primary-addresses.server"

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
const chosenAppId = "b".repeat(12)
const serverId = "c".repeat(12)

// The Relay is the boundary: it lists the routes it marked primary before
// Hearth kept primary addresses, and forgets those Hearth names.
const relay = vi.hoisted(() => ({
  carried: [] as Array<{
    id: string
    resourceId: string
    resourceType: "app" | "instance"
  }>,
  forgotten: [] as Array<string>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { routeIds?: ReadonlyArray<string> }
  ) => {
    if (operation === "instance.network.primaries.carried") {
      return { routes: relay.carried }
    }
    if (operation === "instance.network.primaries.forget") {
      relay.forgotten.push(...(payload.routeIds ?? []))
      return { forgotten: true }
    }
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

afterAll(() => disposeAppRuntime())

describeMysql("Primary routes a Relay kept", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "become their Apps' primary addresses, unless one was chosen since, and the Relay forgets them",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          // Chosen in Hearth after the update, before the Relay connected.
          yield* insertRows("instance_primary_address", {
            address_kind: "route",
            address_ref: "cccccccc",
            chosen_at: 0,
            instance_id: chosenAppId,
            instance_type: "app",
          })
          relay.carried = [
            { id: "aaaaaaaa", resourceId: appId, resourceType: "app" },
            { id: "bbbbbbbb", resourceId: chosenAppId, resourceType: "app" },
            // A game server's primary is one of its join addresses.
            { id: "dddddddd", resourceId: serverId, resourceType: "instance" },
          ]
          relay.forgotten = []

          yield* Effect.promise(() => adoptCarriedPrimaryRoutes(relayId))

          const rows = yield* selectRows<{
            address_kind: string
            address_ref: string
            instance_id: string
          }>("instance_primary_address")
          assert.deepStrictEqual(
            rows
              .map(({ address_kind, address_ref, instance_id }) => ({
                address_kind,
                address_ref,
                instance_id,
              }))
              .sort((a, b) => a.instance_id.localeCompare(b.instance_id)),
            [
              {
                address_kind: "route",
                address_ref: "aaaaaaaa",
                instance_id: appId,
              },
              {
                address_kind: "route",
                address_ref: "cccccccc",
                instance_id: chosenAppId,
              },
            ]
          )
          assert.deepStrictEqual(relay.forgotten, [
            "aaaaaaaa",
            "bbbbbbbb",
            "dddddddd",
          ])
        })
    )
  })
})
