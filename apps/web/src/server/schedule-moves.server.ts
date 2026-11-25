import {
  scheduleActionAppliesToTarget,
  scheduleDefinitionSchema,
  scheduleTargetKey,
  type ScheduleAction,
  type ScheduleDefinition,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"
import { logException } from "@workspace/telemetry"
import { Clock, Effect, Schema } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import {
  isPlatformAdmin,
  listUserGrants,
  type AccessGrant,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { ownerGrant } from "@/lib/resource-permissions"
import { requireScheduleBackupDestinations } from "@/lib/schedule-backup-destinations.server"
import {
  hasScheduleTargetPermission,
  scheduleAuthorizationFailure,
} from "@/lib/schedule-permissions"
import {
  deliverPendingSchedules,
  insertScheduleParts,
  loadSchedules,
  oweSchedule,
  publishScheduleCollectionChange,
} from "@/server/schedule-deployment.server"

// Schedules follow what they run on when it moves: each that names the old
// one names its copy instead, for someone who may edit it so. Moving one
// sends its commands and where it backs up to another Relay, so it takes
// what saving that edit by hand does.

type MovedKind = "app" | "database" | "instance"
type MovedSide = Omit<ScheduleTarget, "kind"> & { readonly kind: MovedKind }
type LoadedSchedule = Awaited<ReturnType<typeof loadSchedules>>[number]

const names = (target: Omit<MovedSide, "name">) => {
  const key = scheduleTargetKey(target)
  return (schedule: ScheduleDefinition) =>
    schedule.targets.some((candidate) => scheduleTargetKey(candidate) === key)
}

/**
 * The schedules a move would take to the copy, and which of them it would
 * leave on the old one, by the Relay it goes to: a name, or null for one the
 * person can't see.
 */
export async function schedulesToMove(
  user: AuthenticatedUser,
  from: Omit<MovedSide, "name">
): Promise<{
  readonly names: ReadonlyArray<string | null>
  readonly staying: (relayId: string) => Promise<Array<string | null>>
}> {
  const schedules = (await loadSchedules()).filter(names(from))
  if (schedules.length === 0) return { names: [], staying: async () => [] }
  const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
  const engine = await engineOf(from)
  const shown = (schedule: LoadedSchedule) =>
    scheduleAuthorizationFailure({
      actions: [],
      grants,
      schedulePermission: "schedule.read",
      targets: schedule.targets,
      user,
    }) === null
      ? schedule.name
      : null
  return {
    names: schedules.map(shown),
    staying: async (relayId) => {
      // It isn't made yet: whoever makes it owns it.
      const copy = { ...from, id: "copy", name: "The copy", relayId }
      const there = [
        ...grants,
        ownerGrant({
          engine,
          relayId,
          resourceId: copy.id,
          resourceType: copy.kind,
        }),
      ]
      const stays = await Promise.all(
        schedules.map((schedule) =>
          whyItStays({ copy, from, grants: there, schedule, user })
        )
      )
      return schedules.flatMap((schedule, index) =>
        stays[index] === null ? [] : [shown(schedule)]
      )
    },
  }
}

// Saved by someone else meanwhile: it's read again.
class ScheduleChanged extends Schema.TaggedError<ScheduleChanged>()(
  "ScheduleChanged",
  {}
) {}

/**
 * Points each schedule that names `from` at `copy`, for someone who may edit
 * it so, and owes it to both Relays, which are sent it in the background. One
 * they may not stays as it was. Asked again, none names the old one.
 */
export const moveSchedulesEffect = Effect.fn("schedules.move")(
  function* (input: {
    readonly copy: MovedSide
    readonly from: Omit<MovedSide, "name">
    readonly user: AuthenticatedUser
  }) {
    const { copy, from, user } = input
    const schedules = (yield* promiseEffect(() => loadSchedules())).filter(
      names(from)
    )
    if (schedules.length === 0) return
    const grants = isPlatformAdmin(user)
      ? []
      : yield* promiseEffect(() => listUserGrants(user.id))
    const relayIds = new Set<string>()
    for (const found of schedules) {
      let schedule: LoadedSchedule | undefined = found
      const move = Effect.gen(function* () {
        if (!schedule || !names(from)(schedule)) return
        const asItIs = schedule
        const stays = yield* promiseEffect(() =>
          whyItStays({ copy, from, grants, schedule: asItIs, user })
        )
        if (stays !== null) {
          yield* Effect.logInfo("A schedule stays with what moved", {
            "schedule.id": found.id,
            reason: stays,
          })
          return
        }
        for (const relayId of yield* repoint(asItIs, from, copy)) {
          relayIds.add(relayId)
        }
      })
      const readAgain = promiseEffect(() => loadSchedules()).pipe(
        Effect.map((loaded) => {
          schedule = loaded.find(({ id }) => id === found.id)
        })
      )
      // One that can't be moved holds up neither the rest nor the move.
      yield* move.pipe(
        Effect.tapError((error) =>
          Schema.is(ScheduleChanged)(error) ? readAgain : Effect.void
        ),
        Effect.retry({ times: 3, while: Schema.is(ScheduleChanged) }),
        Effect.catch((cause) =>
          logException(cause, {
            attributes: { "schedule.id": found.id },
            operation: "schedules.move",
          })
        )
      )
    }
    if (relayIds.size === 0) return
    publishScheduleCollectionChange(relayIds)
    deliverPendingSchedules()
  }
)

// Every Relay it was on or is now is owed it in the same write, so a Hearth
// that stops before sending leaves the sweep something to resend.
const repoint = Effect.fnUntraced(function* (
  schedule: LoadedSchedule,
  from: Omit<MovedSide, "name">,
  copy: MovedSide
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const moved = movedSchedule(schedule, from, copy)
  const relayIds = new Set(
    [...schedule.targets, ...moved.targets].map(({ relayId }) => relayId)
  )
  yield* database.transaction("schedules.move", (transaction) =>
    Effect.gen(function* () {
      const saved = yield* transaction.execute(
        `UPDATE ${databaseTable("schedule")}
            SET revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [moved.revision, now, moved.id, schedule.revision]
      )
      if (saved.affectedRows !== 1) return yield* new ScheduleChanged()
      for (const part of ["schedule_action", "schedule_target"] as const) {
        yield* transaction.execute(
          `DELETE FROM ${databaseTable(part)} WHERE schedule_id = ?`,
          [moved.id]
        )
      }
      // Another target's deletion takes it out itself.
      yield* insertScheduleParts(transaction, moved, now, {
        keepTargetsBeingDeleted: true,
      })
      yield* oweSchedule(transaction, {
        now,
        relayIds,
        revision: moved.revision,
        scheduleId: moved.id,
      })
    })
  )
  return relayIds
})

/** The same schedule, with the copy in the old one's place throughout. */
function movedSchedule(
  schedule: ScheduleDefinition,
  from: Omit<MovedSide, "name">,
  copy: MovedSide
): ScheduleDefinition {
  const old = scheduleTargetKey(from)
  const now = scheduleTargetKey(copy)
  const moved = (key: string) => (key === old ? now : key)
  const { id, kind, name, relayId } = copy
  return scheduleDefinitionSchema.parse({
    actions: schedule.actions.map((action): ScheduleAction => {
      if (action.type === "wait") return action
      const scoped =
        action.targetKeys === undefined
          ? action
          : {
              ...action,
              targetKeys: [...new Set(action.targetKeys.map(moved))],
            }
      return scoped.type === "console_command" && scoped.services
        ? {
            ...scoped,
            services: Object.fromEntries(
              Object.entries(scoped.services).map(([key, service]) => [
                moved(key),
                service,
              ])
            ),
          }
        : scoped
    }),
    continueOnFailure: schedule.continueOnFailure,
    cron: schedule.cron,
    enabled: schedule.enabled,
    id: schedule.id,
    name: schedule.name,
    revision: schedule.revision + 1,
    targets: schedule.targets.flatMap((target) => {
      const key = scheduleTargetKey(target)
      if (key === old) return [{ id, kind, name, relayId }]
      return key === now ? [] : [target]
    }),
  })
}

// Why someone may not point a schedule at the copy; null when they may. It
// takes `schedule.update` and every step's permission on all its targets, as
// it is and as it would be, and its backup destinations, as any edit does.
// Its other targets' steps are as they were.
async function whyItStays(input: {
  readonly copy: MovedSide
  readonly from: Omit<MovedSide, "name">
  readonly grants: ReadonlyArray<AccessGrant>
  readonly schedule: LoadedSchedule
  readonly user: AuthenticatedUser
}): Promise<string | null> {
  const { copy, grants, schedule, user } = input
  const moved = movedSchedule(schedule, input.from, copy)
  for (const { actions, targets } of [schedule, moved]) {
    const failure = scheduleAuthorizationFailure({
      actions,
      grants,
      schedulePermission: "schedule.update",
      targets,
      user,
    })
    if (failure) return failure
  }
  // A stopped backup stops the copy, whose volumes are its alone.
  if (
    copy.kind === "app" &&
    moved.actions.some(
      (action) =>
        action.type === "backup" &&
        action.consistency === "stopped" &&
        scheduleActionAppliesToTarget(action, copy)
    ) &&
    !hasScheduleTargetPermission({
      grants,
      permission: "instance.power.stop",
      target: copy,
      user,
    })
  ) {
    return `You do not have instance.power.stop permission for ${copy.name}`
  }
  return recoverPromise(
    async () => {
      await requireScheduleBackupDestinations({
        actions: schedule.actions,
        grants,
        targets: schedule.targets,
        user,
      })
      await requireScheduleBackupDestinations({
        actions: moved.actions,
        grants,
        owner: schedule.createdBy,
        targets: moved.targets,
        user,
      })
      return null
    },
    (cause) => (cause instanceof Error ? cause.message : String(cause))
  )
}

// What an owner holds on a database depends on its engine.
async function engineOf(
  target: Omit<MovedSide, "name">
): Promise<string | null> {
  if (target.kind !== "database") return null
  const [rows] = await databasePool.query<
    Array<{ engine: string } & RowDataPacket>
  >(
    `SELECT engine FROM ${databaseTable("database")}
      WHERE relay_id = ? AND database_id = ? LIMIT 1`,
    [target.relayId, target.id]
  )
  return rows[0]?.engine ?? null
}
