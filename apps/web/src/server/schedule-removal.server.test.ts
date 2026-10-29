import { layer } from "@effect/vitest"
import {
  relayScheduleProjectionSchema,
  scheduleDefinitionSchema,
  type RelayScheduleProjection,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { Database } from "@/effect/database"
import {
  redeployUnacknowledgedSchedules,
  deploySchedule,
  removeRelayProjections,
} from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

// Each Relay takes a projection as a Relay does, refusing one it can't
// parse, and keeps what it was given.
const relays = vi.hoisted(() => ({
  applied: new Map<string, RelayScheduleProjection>(),
  removing: null as (() => Promise<void>) | null,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { readonly id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation === "schedule.remove") {
      await relays.removing?.()
      relays.applied.delete(relay.id)
      return {}
    }
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
const serverA = {
  id: "1".repeat(40),
  kind: "instance",
  name: "Survival",
  relayId: relayA,
}
describeMysql("periodic schedule removal", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps a newer delivery owed when an old removal replies", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayA, { enabled: true })
        const id = "14bb1e12-fab9-45f3-8f85-ae22d2f074e5"
        const database = yield* Database
        yield* insertRows("schedule", {
          id,
          name: "Nightly",
          cron_expression: "daily",
          timezone: "UTC",
          revision: 2,
          created_by: "owner",
          created_at: 1000,
          updated_at: 2000,
        })
        relays.removing = () =>
          Effect.runPromise(
            database.execute(
              "test.readd",
              "UPDATE kiln_schedule_deployment SET desired_revision = 3, desired_generation = desired_generation + 1, status = 'pending' WHERE schedule_id = ?",
              [id]
            )
          ).then(() => undefined)
        try {
          yield* Effect.promise(() => removeRelayProjections(id, 2, [relayA]))
        } finally {
          relays.removing = null
        }
        expect(yield* selectRows("schedule_deployment")).toEqual([
          expect.objectContaining({ desired_revision: 3, status: "pending" }),
        ])
      })
    )
    for (const deleted of [false, true]) {
      it.effect(
        `retries a lost removal for a ${deleted ? "deleted" : "retargeted"} schedule`,
        () =>
          Effect.gen(function* () {
            yield* resetDatabase
            relays.applied.clear()
            yield* insertRelay(relayA, { enabled: true })
            const id = "14bb1e12-fab9-45f3-8f85-ae22d2f074e5"
            const schedule = scheduleDefinitionSchema.parse({
              actions: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  type: "power",
                  action: "restart",
                },
              ],
              cron: "daily",
              enabled: true,
              id,
              name: "Nightly",
              revision: 1,
              targets: [serverA],
              timezone: "UTC",
            })
            yield* insertRows("schedule", {
              id,
              name: "Nightly",
              cron_expression: "daily",
              timezone: "UTC",
              revision: 2,
              created_by: "owner",
              created_at: 1000,
              updated_at: 2000,
              deleted_at: deleted ? 2000 : null,
            })
            yield* insertRows("schedule_action", {
              id: schedule.actions[0]!.id,
              schedule_id: id,
              position: 0,
              action_type: "power",
              action_config: JSON.stringify(schedule.actions[0]),
              created_at: 1000,
            })
            yield* Effect.promise(() => deploySchedule(schedule, "owner"))
            if (!deleted) {
              const otherRelay = "b".repeat(43)
              yield* insertRelay(otherRelay)
              yield* insertRows("schedule_target", {
                schedule_id: id,
                relay_id: otherRelay,
                target_kind: "instance",
                target_id: "2".repeat(40),
                target_name: "Other",
                created_at: 1000,
              })
            }
            const database = yield* Database
            yield* database.execute(
              "test.removal",
              "UPDATE kiln_schedule_deployment SET desired_revision = 2, status = 'pending'"
            )
            yield* Effect.promise(redeployUnacknowledgedSchedules)
            expect(relays.applied.has(relayA)).toBe(false)
            expect(yield* selectRows("schedule_deployment")).toEqual([])
          }),
        60000
      )
    }
  })
})
