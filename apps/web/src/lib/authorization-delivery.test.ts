import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
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
  reviseRelayIssuerGenerationNow,
  synchronizeRelayIssuerGeneration,
  wakeAuthorizationDelivery,
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
  vi.useRealTimers()
})

describeMysql("authorization delivery", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps a partially acknowledged batch pending and retries it until Relay persists it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* relayWithGeneration("relay-partial", 9, 9)
          yield* insertRows(
            "authorization_delivery",
            delivery("relay-partial", "instance-one", 2)
          )
          const acknowledgeAll = {
            issuerGeneration: 9,
            items: [
              {
                minimumRevision: 2,
                scope: { instanceId: "instance-one", kind: "instance" },
                subject: "user",
              },
            ],
          }
          relay.rpc
            .mockResolvedValueOnce({ issuerGeneration: 9, items: [] })
            .mockResolvedValue(acknowledgeAll)
          // Only the retry timer is faked; database I/O and Effect keep running.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

          wakeAuthorizationDelivery("relay-partial")
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(relay.rpc).toHaveBeenCalled())
          )
          expect(yield* deliveries).toEqual({ "instance-one": [2, 0] })

          // The retry delivers once Relay acknowledges the whole batch.
          const readDeliveries = Effect.runPromiseWith(
            yield* Effect.context<SqlClient.SqlClient>()
          )
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(3_000))
          yield* Effect.promise(() =>
            vi.waitFor(async () =>
              expect(await readDeliveries(deliveries)).toEqual({})
            )
          )
        })
    )

    it.effect("raises Hearth's issuer generation when Relay is ahead", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* relayWithGeneration("relay-one", 4, 3)
        relay.rpc.mockResolvedValue({ issuerGeneration: 9, items: [] })

        const synchronized = yield* Effect.promise(() =>
          reviseRelayIssuerGenerationNow("relay-one", 4)
        )

        expect(synchronized).toBe(true)
        expect(yield* generation("relay-one")).toEqual([9, 9])
      })
    )

    it.effect(
      "does not contact Relay when the issuer generation is already synchronized",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* relayWithGeneration("relay-one", 9, 9)

          const current = yield* Effect.promise(() =>
            synchronizeRelayIssuerGeneration("relay-one", 9)
          )

          expect(current).toBe(9)
          expect(relay.rpc).not.toHaveBeenCalled()
          expect(yield* generation("relay-one")).toEqual([9, 9])
        })
    )

    it.effect(
      "persists a pending issuer generation on Relay before reporting it ready",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* relayWithGeneration("relay-one", 4, 3)
          relay.rpc.mockResolvedValue({ issuerGeneration: 4, items: [] })

          const current = yield* Effect.promise(() =>
            synchronizeRelayIssuerGeneration("relay-one", 3)
          )

          expect(current).toBe(4)
          expect(relay.rpc).toHaveBeenCalledWith(
            expect.objectContaining({ id: "relay-one" }),
            "browser.authorization.revise",
            { items: [], minimumIssuerGeneration: 4 },
            expect.any(Number)
          )
          expect(yield* generation("relay-one")).toEqual([4, 4])
        })
    )

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
