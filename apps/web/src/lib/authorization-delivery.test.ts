import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

// The Relay control channel is the only external boundary here.
const relay = vi.hoisted(() => ({
  features: new Set<string>(["browser-capability-v2"]),
  rpc: vi.fn(),
}))
vi.mock("@/lib/relay-connection", () => ({
  relayConnectionFeatures: () => relay.features,
  relayRpc: relay.rpc,
}))

import {
  acknowledgeAuthorizationDeliveryEffect,
  synchronizeRelayIssuerGeneration,
} from "./authorization-delivery"

interface RelayGenerationRow {
  id: string
  issuer_generation: number
  acknowledged_issuer_generation: number
}

interface DeliveryRow {
  scope_id: string
  desired_revision: number
  acknowledged_revision: number
}

const generation = (id: string) =>
  Effect.map(selectRows<RelayGenerationRow>("relay"), (rows) => {
    const row = rows.find((row) => row.id === id)
    return [
      Number(row?.issuer_generation),
      Number(row?.acknowledged_issuer_generation),
    ]
  })

const deliveries = Effect.map(
  selectRows<DeliveryRow>("authorization_delivery"),
  (rows) =>
    Object.fromEntries(
      rows.map((row) => [
        row.scope_id,
        [Number(row.desired_revision), Number(row.acknowledged_revision)],
      ])
    )
)

const delivery = (relayId: string, instanceId: string, desired: number) => ({
  relay_id: relayId,
  subject_id: "user",
  scope_kind: "instance",
  scope_id: instanceId,
  desired_revision: desired,
  acknowledged_revision: 0,
  updated_at: 0,
})

const relayWithGeneration = (
  id: string,
  issuer: number,
  acknowledged: number
) =>
  insertRelay(id, {
    issuer_generation: issuer,
    acknowledged_issuer_generation: acknowledged,
  })

afterEach(() => {
  relay.rpc.mockReset()
})

describeMysql("authorization delivery", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "advances past a Relay that rolled back so older capabilities stay invalid",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* relayWithGeneration("relay-one", 9, 9)
          relay.rpc.mockImplementation(
            async (
              _relay,
              _method,
              input: { minimumIssuerGeneration: number }
            ) => ({
              issuerGeneration: input.minimumIssuerGeneration,
              items: [],
            })
          )

          const current = yield* Effect.promise(() =>
            synchronizeRelayIssuerGeneration("relay-one", 5)
          )

          expect(current).toBe(10)
          expect(yield* generation("relay-one")).toEqual([10, 10])
        })
    )

    it.effect(
      "prunes only delivery rows whose desired revision is acknowledged",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* relayWithGeneration("relay-one", 3, 3)
          yield* insertRows("authorization_delivery", [
            delivery("relay-one", "acknowledged", 8),
            delivery("relay-one", "advanced", 10),
          ])
          const database = yield* Database

          yield* database.transaction("test", (transaction) =>
            acknowledgeAuthorizationDeliveryEffect(transaction, "relay-one", {
              issuerGeneration: 4,
              items: ["acknowledged", "advanced"].map((instanceId) => ({
                minimumRevision: 8,
                scope: { instanceId, kind: "instance" as const },
                subject: "user",
              })),
            })
          )

          expect(yield* deliveries).toEqual({ advanced: [10, 8] })
          expect(yield* generation("relay-one")).toEqual([4, 4])
        })
    )
  })
})
