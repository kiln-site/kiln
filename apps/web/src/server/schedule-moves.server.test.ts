import { layer } from "@effect/vitest"
import {
  relayScheduleProjectionSchema,
  scheduleActionSchema,
  type RelayScheduleProjection,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import {
  moveSchedulesEffect,
  schedulesToMove,
} from "@/server/schedule-moves.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// What each Relay runs, as it takes and drops what it's sent.
const relays = vi.hoisted(() => ({
  running: new Map<string, RelayScheduleProjection>(),
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { readonly id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation === "schedule.remove") {
      relays.running.delete(relay.id)
      return {}
    }
    if (operation !== "schedule.apply") throw new Error("Relay is offline")
    const projection = relayScheduleProjectionSchema.parse(payload)
    relays.running.set(relay.id, projection)
    return {
      acknowledgedGeneration: projection.generation,
      acknowledgedRevision: projection.revision,
      nextRunAt: null,
      scheduleId: projection.id,
    }
  },
}))

afterAll(async () => {
  await stopScheduleDeliveries()
  await disposeAppRuntime()
})

const oldRelay = "01".repeat(6)
const newRelay = "02".repeat(6)
const scheduleId = "14bb1e12-fab9-45f3-8f85-ae22d2f074e5"

const admin: AuthenticatedUser = {
  email: "admin@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "admin",
  isDevelopmentBypass: false,
  name: "Admin",
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}
const person: AuthenticatedUser = { ...admin, id: "person", role: "user" }

const old = {
  id: "a1".repeat(6),
  kind: "app" as const,
  name: "Website",
  relayId: oldRelay,
}
const copy = { ...old, id: "b2".repeat(6), relayId: newRelay }
const server: ScheduleTarget = {
  id: "c3".repeat(6),
  kind: "instance",
  name: "Survival",
  relayId: oldRelay,
}
const key = (target: ScheduleTarget) =>
  `${target.relayId}:${target.kind}:${target.id}`

const command: ScheduleAction = {
  authorizedTargets: 2,
  command: "refresh",
  id: "22222222-2222-4222-8222-222222222222",
  services: { [key(old)]: "web" },
  targetKeys: [key(old), key(server)],
  type: "console_command",
}

const shell: ScheduleAction = { ...command, targetKeys: [key(old)] }

const seedSchedule = (
  targets: ReadonlyArray<ScheduleTarget>,
  actions: ReadonlyArray<ScheduleAction>
) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relays.running.clear()
    for (const user of [admin, person]) yield* insertUser(user.id)
    yield* insertRelay(oldRelay, { enabled: true })
    yield* insertRelay(newRelay, { enabled: true })
    yield* insertRows("schedule", {
      id: scheduleId,
      name: "Nightly",
      cron_expression: "0 4 * * *",
      revision: 3,
      created_by: admin.id,
      created_at: 1000,
      updated_at: 1000,
    })
    yield* insertRows(
      "schedule_action",
      actions.map((action, position) => ({
        id: action.id,
        schedule_id: scheduleId,
        position,
        action_type: action.type,
        action_config: JSON.stringify(action),
        created_at: 1000,
      }))
    )
    yield* insertRows(
      "schedule_target",
      targets.map((target) => ({
        schedule_id: scheduleId,
        relay_id: target.relayId,
        target_kind: target.kind,
        target_id: target.id,
        target_name: target.name,
        created_at: 1000,
      }))
    )
  })

const targeted = selectRows<{ target_id: string }>("schedule_target").pipe(
  Effect.map((rows) => rows.map((row) => row.target_id))
)

const grant = (relayId: string, permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = `3333333${relayId.at(-1)}-3333-4333-8333-333333333333`
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      state: "active",
      userId: person.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

describeMysql("schedules of what moves", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "run on the copy, on its Relay, and on their others as before",
      () =>
        Effect.gen(function* () {
          yield* seedSchedule([old, server], [command])
          yield* moveSchedulesEffect({ copy, from: old, user: admin })

          expect((yield* targeted).sort()).toEqual([copy.id, server.id].sort())
          const [stored] = yield* selectRows<{ action_config: string }>(
            "schedule_action"
          )
          const config = stored!.action_config
          expect(
            scheduleActionSchema.parse(
              typeof config === "string" ? JSON.parse(config) : config
            )
          ).toMatchObject({
            services: { [key(copy)]: "web" },
            targetKeys: [key(copy), key(server)],
          })
          // Each Relay runs only its own part.
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(relays.running.get(newRelay)?.targets).toEqual([copy])
              expect(relays.running.get(oldRelay)?.targets).toEqual([server])
            })
          )
        })
    )

    it.effect("leave the old Relay when they ran on nothing else there", () =>
      Effect.gen(function* () {
        yield* seedSchedule([old], [shell])
        relays.running.set(oldRelay, {} as RelayScheduleProjection)
        yield* moveSchedulesEffect({ copy, from: old, user: admin })
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect([...relays.running.keys()]).toEqual([newRelay])
          })
        )
      })
    )

    it.effect(
      "stay where they were for someone who couldn't save them so",
      () =>
        Effect.gen(function* () {
          yield* seedSchedule([old], [shell])
          // A shell on the old Relay says nothing of one on the new.
          yield* grant(oldRelay, [
            "schedule.read",
            "schedule.update",
            "instance.terminal",
          ])
          yield* grant(newRelay, ["app.create", "schedule.update"])
          const staying = () =>
            Effect.promise(async () =>
              (await schedulesToMove(person, old)).staying(newRelay)
            )

          expect(yield* staying()).toEqual(["Nightly"])
          yield* moveSchedulesEffect({ copy, from: old, user: person })
          expect(yield* targeted).toEqual([old.id])

          yield* insertRows("access_selection", {
            access_id: "33333332-3333-4333-8333-333333333333",
            selection_kind: "permission",
            selection_key: "instance.terminal",
          })
          expect(yield* staying()).toEqual([])
          yield* moveSchedulesEffect({ copy, from: old, user: person })
          expect(yield* targeted).toEqual([copy.id])
        })
    )

    it.effect(
      "stay when another of their targets is out of reach, unnamed",
      () =>
        Effect.gen(function* () {
          const restart: ScheduleAction = {
            action: "restart",
            authorizedTargets: 2,
            id: command.id,
            type: "power",
          }
          const owned = { ...server, kind: "instance" as const }
          const other = { ...server, id: "d4".repeat(6), name: "Private" }
          yield* seedSchedule([owned, other], [restart])
          yield* insertInstance(oldRelay, owned.id, { owner_id: person.id })
          yield* insertInstance(oldRelay, other.id, { owner_id: admin.id })
          const moved = { ...owned, id: "e5".repeat(6), relayId: newRelay }
          yield* insertInstance(newRelay, moved.id, { owner_id: person.id })

          const { names, staying } = yield* Effect.promise(() =>
            schedulesToMove(person, owned)
          )
          expect(names).toEqual([null])
          expect(yield* Effect.promise(() => staying(newRelay))).toEqual([null])
          yield* moveSchedulesEffect({ copy: moved, from: owned, user: person })
          expect((yield* targeted).sort()).toEqual([owned.id, other.id].sort())
        })
    )
  })
})
