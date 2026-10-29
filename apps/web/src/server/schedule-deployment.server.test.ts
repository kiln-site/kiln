import { layer } from "@effect/vitest"
import {
  relayScheduleProjectionSchema,
  scheduleActionAppliesToTarget,
  scheduleDefinitionSchema,
  type RelayScheduleProjection,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { deploySchedule } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

// Each Relay takes a projection as a Relay does, refusing one it can't
// parse, and keeps what it was given.
const relays = vi.hoisted(() => ({
  applied: new Map<string, RelayScheduleProjection>(),
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { readonly id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation !== "schedule.apply") throw new Error("Relay is offline")
    const projection = relayScheduleProjectionSchema.parse(payload)
    relays.applied.set(relay.id, projection)
    return {
      acknowledgedRevision: projection.revision,
      nextRunAt: null,
      scheduleId: projection.id,
    }
  },
}))

afterAll(() => disposeAppRuntime())

const relayA = "a".repeat(43)
const relayB = "b".repeat(43)
const appA = { id: "1".repeat(40), kind: "app", name: "Shop", relayId: relayA }
const appB = { id: "2".repeat(40), kind: "app", name: "Blog", relayId: relayB }
const keyA = `${relayA}:app:${appA.id}`

describeMysql("schedule deployment", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "gives each Relay only its own targets of a step",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relays.applied.clear()
          yield* insertRelay(relayA, { enabled: true })
          yield* insertRelay(relayB, { enabled: true })
          const schedule = scheduleDefinitionSchema.parse({
            actions: [
              {
                authorizedTargets: 2,
                command: "./migrate",
                id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
                services: { [keyA]: "web" },
                targetKeys: [keyA],
                type: "console_command",
              },
              {
                action: "restart",
                id: "a4c1e6b9-2f7d-4c0a-8e35-7b9d2c6f1e44",
                type: "power",
              },
            ],
            cron: "daily",
            enabled: true,
            id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
            name: "Nightly",
            revision: 1,
            targets: [appA, appB],
            timezone: "UTC",
          })
          yield* insertRows("schedule", {
            cron_expression: schedule.cron,
            created_at: 1_000,
            created_by: "user-a",
            id: schedule.id,
            name: schedule.name,
            revision: 1,
            timezone: "UTC",
            updated_at: 1_000,
          })

          yield* Effect.promise(() => deploySchedule(schedule, "user-a"))

          const onA = relays.applied.get(relayA)
          const onB = relays.applied.get(relayB)
          expect(onA?.targets).toEqual([appA])
          expect(onB?.targets).toEqual([appB])
          // Only Shop runs the command; Blog still restarts.
          const runs = (projection: RelayScheduleProjection | undefined) =>
            projection?.actions.map((action) =>
              projection.targets
                .filter((target) =>
                  scheduleActionAppliesToTarget(action, target)
                )
                .map((target) => target.name)
            )
          expect(runs(onA)).toEqual([["Shop"], ["Shop"]])
          expect(runs(onB)).toEqual([[], ["Blog"]])
          expect(onA?.actions[0]).toMatchObject({
            authorizedTargets: 2,
            services: { [keyA]: "web" },
          })
          expect(onB?.actions[0]).toMatchObject({ targetKeys: [] })
          expect(onB?.actions[0]).not.toHaveProperty("services")
        }),
      60_000
    )
  })
})
