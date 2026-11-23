import { layer } from "@effect/vitest"
import {
  relayScheduleProjectionSchema,
  scheduleDefinitionSchema,
  type RelayScheduleProjection,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import {
  deploySchedule,
  insertSchedule,
  oweLostSchedules,
  redeployUnacknowledgedSchedules,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

// A Relay that says which schedules it has, and takes what it's sent.
const relay = vi.hoisted(() => ({
  applied: 0,
  schedules: new Map<string, RelayScheduleProjection>(),
}))
const deployment = (projection: RelayScheduleProjection) => ({
  acknowledgedGeneration: projection.generation,
  acknowledgedRevision: projection.revision,
  nextRunAt: null,
  scheduleId: projection.id,
})
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "schedule.overview") {
      return {
        deployments: [...relay.schedules.values()].map(deployment),
        runs: [],
      }
    }
    if (operation !== "schedule.apply") throw new Error("Relay is offline")
    const projection = relayScheduleProjectionSchema.parse(payload)
    relay.applied += 1
    relay.schedules.set(projection.id, projection)
    return deployment(projection)
  },
}))

afterAll(() => disposeAppRuntime())

const relayId = "a".repeat(12)

describeMysql("schedules a Relay lost", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "are sent to it again, though it had taken them",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId, { enabled: true })
          const schedule = scheduleDefinitionSchema.parse({
            actions: [
              {
                action: "restart",
                id: "a4c1e6b9-2f7d-4c0a-8e35-7b9d2c6f1e44",
                type: "power",
              },
            ],
            cron: "0 3 * * *",
            enabled: true,
            id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
            name: "Nightly",
            revision: 1,
            targets: [
              { id: "1".repeat(12), kind: "app", name: "Shop", relayId },
            ],
          })
          const database = yield* Database
          yield* database.transaction("test.schedule", (transaction) =>
            insertSchedule(transaction, schedule, "user-a", 1_000)
          )
          yield* Effect.promise(() => deploySchedule(schedule, "user-a"))
          expect(relay.schedules.has(schedule.id)).toBe(true)

          // What it still has isn't sent again.
          relay.applied = 0
          yield* Effect.promise(() => oweLostSchedules())
          yield* Effect.promise(() => redeployUnacknowledgedSchedules())
          expect(relay.applied).toBe(0)

          // Restored on a new machine, with none of them.
          relay.schedules.clear()
          yield* Effect.promise(() => oweLostSchedules())
          yield* Effect.promise(() => redeployUnacknowledgedSchedules())

          expect(relay.schedules.get(schedule.id)?.targets).toEqual(
            schedule.targets
          )
        }),
      60_000
    )
  })
})
