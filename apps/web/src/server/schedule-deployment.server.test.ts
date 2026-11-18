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
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import {
  deploySchedule,
  redeployUnacknowledgedSchedules,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

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
    // A newer generation of the same revision is kept over this one.
    const held = relays.applied.get(relay.id)
    const kept =
      held &&
      held.revision === projection.revision &&
      (held.generation ?? 0) > (projection.generation ?? 0)
        ? held
        : projection
    relays.applied.set(relay.id, kept)
    return {
      acknowledgedGeneration: kept.generation,
      acknowledgedRevision: kept.revision,
      nextRunAt: null,
      scheduleId: kept.id,
    }
  },
}))

afterAll(() => disposeAppRuntime())

const relayA = "a".repeat(12)
const relayB = "b".repeat(12)
const appA = { id: "1".repeat(12), kind: "app", name: "Shop", relayId: relayA }
const appB = { id: "2".repeat(12), kind: "app", name: "Blog", relayId: relayB }
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
          })
          yield* insertRows("schedule", {
            cron_expression: schedule.cron,
            created_at: 1_000,
            created_by: "user-a",
            id: schedule.id,
            name: schedule.name,
            revision: 1,
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

    it.effect(
      "takes over a projection a Relay kept from before Kiln was restored",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relays.applied.clear()
          yield* insertRelay(relayA, { enabled: true })
          const schedule = scheduleDefinitionSchema.parse({
            actions: [
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
            targets: [appA],
          })
          yield* insertRows("schedule", {
            cron_expression: schedule.cron,
            created_at: 1_000,
            created_by: "user-a",
            id: schedule.id,
            name: schedule.name,
            revision: 1,
            updated_at: 1_000,
          })
          yield* insertRows("schedule_action", {
            action_config: JSON.stringify(schedule.actions[0]),
            action_type: "power",
            created_at: 1_000,
            id: schedule.actions[0]!.id,
            position: 0,
            schedule_id: schedule.id,
          })
          yield* insertRows("schedule_target", {
            created_at: 1_000,
            relay_id: relayA,
            schedule_id: schedule.id,
            target_id: appA.id,
            target_kind: "app",
            target_name: appA.name,
          })
          // The lost machine's Hearth sent this revision five times.
          yield* Effect.promise(() => deploySchedule(schedule, "user-a"))
          relays.applied.set(relayA, {
            ...relays.applied.get(relayA)!,
            generation: 5,
            name: "Nightly (lost)",
          })
          // Restored, Hearth owes its Relays their schedules again.
          yield* Effect.promise(() =>
            databasePool.execute(
              `UPDATE ${databaseTable("schedule_deployment")} SET status = 'pending'`
            )
          )

          // The first send is below what the Relay kept; the next isn't.
          yield* Effect.promise(() => redeployUnacknowledgedSchedules())
          expect(relays.applied.get(relayA)?.name).toBe("Nightly (lost)")
          yield* Effect.promise(() => redeployUnacknowledgedSchedules())

          expect(relays.applied.get(relayA)).toMatchObject({
            name: "Nightly",
            targets: [appA],
          })
          expect(
            yield* selectRows<{ status: string }>("schedule_deployment")
          ).toMatchObject([{ status: "applied" }])
        }),
      60_000
    )
  })
})
