import { randomUUID } from "node:crypto"

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { Clock, Data, Effect, Result } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import { relaySnapshotSchema } from "@workspace/contracts"
import {
  normalizeScheduleCron,
  scheduleActionSchema,
  relayScheduleOverviewSchema,
  scheduleDefinitionSchema,
  scheduleInputSchema,
  scheduleRunSchema,
  scheduleTargetSchema,
  type ScheduleAction,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"

import { Database } from "@/effect/database"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import {
  isPlatformAdmin,
  listUserGrants,
  type AccessGrant,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  hasScheduleTargetPermission,
  scheduleActionOptionPermissions,
  scheduleAuthorizationFailure,
} from "@/lib/schedule-permissions"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireScheduleBackupDestinations } from "@/lib/schedule-backup-destinations.server"
import { scheduleTargetsWithAvailability } from "@/lib/schedule-target-options"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  deploySchedule,
  deployScheduleToRelay,
  errorMessage,
  groupRows,
  insertSchedule,
  insertScheduleParts,
  jsonValue,
  loadSchedules,
  publishScheduleCollectionChange,
  scheduleReconciliationConcurrency,
  removeRelayProjections,
  type ScheduleActionRow,
  type ScheduleRow,
  type ScheduleTargetRow,
} from "@/server/schedule-deployment.server"

const scheduleWriteSchema = scheduleInputSchema

const scheduleUpdateSchema = scheduleWriteSchema.safeExtend({
  id: z.uuid(),
  revision: z.number().int().positive(),
})
const scheduleIdSchema = z.strictObject({ id: z.uuid() })
const scheduleReconciliationIntervalMs = 60_000
let scheduleReconciliationActive = false
let nextScheduleReconciliationAt = 0

class ScheduleRevisionConflictError extends Data.TaggedError(
  "ScheduleRevisionConflictError"
)<{ readonly message: string }> {}

interface StoredScheduleIdRow extends RowDataPacket {
  id: string
}

interface ScheduleTombstoneRow extends RowDataPacket {
  desired_revision: number
  relay_id: string
  schedule_id: string
}

interface TargetDirectoryRow extends RowDataPacket {
  id: string
  kind: ScheduleTarget["kind"]
  name: string
  relay_id: string
}

export const getScheduleOptions = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const [grants, availableTargets, referencedTargets, relays] =
      await Promise.all([
        isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
        loadTargetDirectory(),
        loadReferencedScheduleTargets(),
        listPersistedRelays(),
      ])
    const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
    const targets = scheduleTargetsWithAvailability(
      availableTargets,
      referencedTargets
    )
    return targets.flatMap((target) => {
      // Kiln's backups are platform administrators' alone.
      if (target.kind === "relay" && !isPlatformAdmin(user)) return []
      if (
        !hasScheduleTargetPermission({
          grants,
          permission: "schedule.read",
          target,
          user,
        })
      ) {
        return []
      }
      const permittedActions = (
        ["console_command", "backup", "power", "wait"] as const
      ).filter((type) => {
        const permissions = scheduleActionOptionPermissions(type, target)
        return (
          permissions.length === 0 ||
          permissions.some((permission) =>
            hasScheduleTargetPermission({ grants, permission, target, user })
          )
        )
      })
      return [
        {
          ...target,
          relayName: relayNames.get(target.relayId) ?? target.relayId,
          canCreate:
            target.available &&
            hasScheduleTargetPermission({
              grants,
              permission: "schedule.create",
              target,
              user,
            }),
          canDelete: hasScheduleTargetPermission({
            grants,
            permission: "schedule.delete",
            target,
            user,
          }),
          canExecute: hasScheduleTargetPermission({
            grants,
            permission: "schedule.execute",
            target,
            user,
          }),
          canUpdate: hasScheduleTargetPermission({
            grants,
            permission: "schedule.update",
            target,
            user,
          }),
          permittedActions,
        },
      ]
    })
  }
)

export const getSchedules = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedules = await loadSchedules()
    const visible = schedules.filter(
      (schedule) =>
        scheduleAuthorizationFailure({
          actions: [],
          grants,
          schedulePermission: "schedule.read",
          targets: schedule.targets,
          user,
        }) === null
    )
    requestScheduleReconciliation(schedules)
    return visible
  }
)

export const createSchedule = createServerFn({ method: "POST" })
  .validator(scheduleWriteSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const definition = scheduleDefinitionSchema.parse({
      ...data,
      cron: normalizeScheduleCron(data.cron),
      id: randomUUID(),
      revision: 1,
      targets: await canonicalTargets(data.targets),
    })
    requireScheduleAuthorization({
      actions: definition.actions,
      grants,
      schedulePermission: "schedule.create",
      targets: definition.targets,
      user,
    })
    await requireScheduleBackupDestinations({
      actions: definition.actions,
      owner: user.id,
      targets: definition.targets,
      grants,
      user,
    })
    await requireContinueOnFailureSupport(definition)
    await saveNewSchedule(definition, user.id)
    await deploySchedule(definition, user.id)
    const created = (await loadSchedules()).find(
      (schedule) => schedule.id === definition.id
    )
    publishScheduleCollectionChange(
      definition.targets.map((target) => target.relayId)
    )
    return created
  })

export const updateSchedule = createServerFn({ method: "POST" })
  .validator(scheduleUpdateSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const existing = (await loadSchedules()).find(
      (schedule) => schedule.id === data.id
    )
    if (!existing) throw new Error("Schedule not found")
    if (existing.revision !== data.revision) {
      throw new ScheduleRevisionConflictError({
        message:
          "This schedule changed after you opened it. Refresh and try again.",
      })
    }

    // Editing is all-or-nothing. The user must still be authorized for every
    // stored action, even when the proposed change removes that action.
    requireScheduleAuthorization({
      actions: existing.actions,
      grants,
      schedulePermission: "schedule.update",
      targets: existing.targets,
      user,
    })
    await requireScheduleBackupDestinations({
      actions: existing.actions,
      targets: existing.targets,
      grants,
      user,
    })
    const definition = scheduleDefinitionSchema.parse({
      ...data,
      cron: normalizeScheduleCron(data.cron),
      revision: data.revision + 1,
      targets: await canonicalTargets(data.targets),
    })
    requireScheduleAuthorization({
      actions: definition.actions,
      grants,
      schedulePermission: "schedule.update",
      targets: definition.targets,
      user,
    })
    await requireScheduleBackupDestinations({
      actions: definition.actions,
      owner: existing.createdBy,
      targets: definition.targets,
      grants,
      user,
    })
    await requireContinueOnFailureSupport(definition, existing)
    const previousRelayIds = new Set(
      existing.targets.map((target) => target.relayId)
    )
    await replaceSchedule(definition, data.revision)
    await deploySchedule(definition, user.id)
    const nextRelayIds = new Set(
      definition.targets.map((target) => target.relayId)
    )
    await removeRelayProjections(
      definition.id,
      definition.revision,
      [...previousRelayIds].filter((relayId) => !nextRelayIds.has(relayId)),
      user.id
    )
    const updated = (await loadSchedules()).find(
      (schedule) => schedule.id === definition.id
    )
    publishScheduleCollectionChange([...previousRelayIds, ...nextRelayIds])
    return updated
  })

export const deleteSchedule = createServerFn({ method: "POST" })
  .validator(scheduleIdSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedule = (await loadSchedules()).find(
      (candidate) => candidate.id === data.id
    )
    if (!schedule) throw new Error("Schedule not found")
    requireScheduleAuthorization({
      actions: [],
      grants,
      schedulePermission: "schedule.delete",
      targets: schedule.targets,
      user,
    })
    const revision = schedule.revision + 1
    const now = Date.now()
    await databasePool.execute(
      `UPDATE ${databaseTable("schedule")}
          SET enabled = FALSE, revision = ?, deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [revision, now, now, schedule.id]
    )
    publishScheduleCollectionChange(
      schedule.targets.map((target) => target.relayId)
    )
    await removeRelayProjections(
      schedule.id,
      revision,
      [...new Set(schedule.targets.map((target) => target.relayId))],
      user.id
    )
    return { deleted: true, id: schedule.id }
  })

/**
 * Takes a deleted resource out of every schedule that targets it, as system
 * work whoever asked for the deletion. Each schedule is read and rewritten
 * holding its row, so an edit saved at the same time waits or is waited on;
 * actions that named it stop naming it. A schedule left with no targets is
 * deleted, since it can't run anything. Once committed, the changes are sent
 * to the Relays; one that doesn't take it is sent again by
 * `redeployUnacknowledgedSchedules`.
 */
export const removeDeletedResourceFromSchedules = createServerOnlyFn(async (
  resource: Pick<ScheduleTarget, "id" | "kind" | "relayId">,
  subject: string
) => {
  const deletedKey = targetKey({ ...resource, name: "" })
  const changed = await runAppEffect(
    "schedules.removeDeletedTarget",
    Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      return yield* database.transaction(
        "schedules.removeDeletedTarget",
        (transaction) =>
          Effect.gen(function* () {
            const affected = yield* transaction.queryRows<
              { schedule_id: string } & RowDataPacket
            >(
              `SELECT DISTINCT target.schedule_id
                 FROM ${databaseTable("schedule_target")} target
                WHERE target.relay_id = ? AND target.target_kind = ?
                  AND target.target_id = ?
                ORDER BY target.schedule_id`,
              [resource.relayId, resource.kind, resource.id]
            )
            const changes: Array<{
              relayIds: ReadonlyArray<string>
              schedule: ScheduleDefinition | null
              scheduleId: string
              revision: number
            }> = []
            for (const { schedule_id: scheduleId } of affected) {
              const [row] = yield* transaction.queryRows<ScheduleRow>(
                `SELECT id, name, cron_expression, timezone, enabled,
                        continue_on_failure, revision, created_by, created_at,
                        updated_at
                   FROM ${databaseTable("schedule")}
                  WHERE id = ? AND deleted_at IS NULL
                  FOR UPDATE`,
                [scheduleId]
              )
              if (!row) continue
              // Locking reads, like the row above: they see what's committed
              // now, not the snapshot the first read of this transaction took.
              const actions = yield* transaction.queryRows<ScheduleActionRow>(
                `SELECT id, schedule_id, position, action_type, action_config
                   FROM ${databaseTable("schedule_action")}
                  WHERE schedule_id = ?
                  ORDER BY position
                  FOR UPDATE`,
                [scheduleId]
              )
              const targets = (
                yield* transaction.queryRows<ScheduleTargetRow>(
                  `SELECT schedule_id, relay_id, target_kind, target_id,
                          target_name
                     FROM ${databaseTable("schedule_target")}
                    WHERE schedule_id = ?
                    ORDER BY relay_id, target_kind, target_name
                    FOR UPDATE`,
                  [scheduleId]
                )
              ).map(
                (target): ScheduleTarget => ({
                  id: target.target_id,
                  kind: target.target_kind,
                  name: target.target_name,
                  relayId: target.relay_id,
                })
              )
              const relayIds = [
                ...new Set(targets.map((target) => target.relayId)),
              ]
              const remaining = targets.filter(
                (target) => targetKey(target) !== deletedKey
              )
              const revision = row.revision + 1
              if (remaining.length === 0) {
                yield* transaction.execute(
                  `UPDATE ${databaseTable("schedule")}
                      SET enabled = FALSE, revision = ?, deleted_at = ?,
                          updated_at = ?
                    WHERE id = ?`,
                  [revision, now, now, scheduleId]
                )
                changes.push({ relayIds, revision, schedule: null, scheduleId })
                continue
              }
              const schedule = scheduleDefinitionSchema.parse({
                // An action that named it names the rest; one that named
                // only it keeps an empty list rather than running on all.
                actions: actions.map((action) => {
                  const parsed = scheduleActionSchema.parse(
                    jsonValue(action.action_config)
                  )
                  return parsed.type === "wait" ||
                    parsed.targetKeys === undefined
                    ? parsed
                    : {
                        ...parsed,
                        targetKeys: parsed.targetKeys.filter(
                          (key) => key !== deletedKey
                        ),
                      }
                }),
                continueOnFailure: Boolean(row.continue_on_failure),
                cron: row.cron_expression,
                enabled: Boolean(row.enabled),
                id: row.id,
                name: row.name,
                revision,
                targets: remaining,
                timezone: row.timezone,
              })
              yield* transaction.execute(
                `UPDATE ${databaseTable("schedule")}
                    SET revision = ?, updated_at = ?
                  WHERE id = ?`,
                [revision, now, scheduleId]
              )
              yield* transaction.execute(
                `DELETE FROM ${databaseTable("schedule_action")} WHERE schedule_id = ?`,
                [scheduleId]
              )
              yield* transaction.execute(
                `DELETE FROM ${databaseTable("schedule_target")} WHERE schedule_id = ?`,
                [scheduleId]
              )
              yield* insertScheduleParts(transaction, schedule, now, {
                keepTargetsBeingDeleted: true,
              })
              changes.push({ relayIds, revision, schedule, scheduleId })
            }
            // Owed to every Relay it was on, so a Hearth that stops before
            // sending leaves the sweep something to resend.
            for (const change of changes) {
              for (const relayId of change.relayIds) {
                yield* transaction.execute(
                  `INSERT INTO ${databaseTable("schedule_deployment")}
                     (schedule_id, relay_id, desired_revision, status,
                      created_at, updated_at)
                   VALUES (?, ?, ?, 'pending', ?, ?)
                   ON DUPLICATE KEY UPDATE
                     status = IF(VALUES(desired_revision) >= desired_revision,
                       'pending', status),
                     last_error = IF(VALUES(desired_revision) >= desired_revision,
                       NULL, last_error),
                     desired_revision = GREATEST(desired_revision,
                       VALUES(desired_revision)),
                     updated_at = VALUES(updated_at)`,
                  [change.scheduleId, relayId, change.revision, now, now]
                )
              }
            }
            return changes
          })
      )
    })
  )
  // Delivery only: what each Relay should run is already saved.
  for (const change of changed) {
    const remaining = new Set(
      change.schedule?.targets.map((target) => target.relayId) ?? []
    )
    await recoverPromise(
        async () => {
          if (change.schedule) await deploySchedule(change.schedule, subject)
          await removeRelayProjections(
            change.scheduleId,
            change.revision,
            change.relayIds.filter((relayId) => !remaining.has(relayId)),
            subject
          )
        },
      (cause) => {
        console.warn(
          `[Kiln Schedules] Couldn't send schedule ${change.scheduleId} after a deletion:`,
          cause
        )
      }
    )
    publishScheduleCollectionChange(change.relayIds)
  }
})

export const runScheduleNow = createServerFn({ method: "POST" })
  .validator(scheduleIdSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const schedule = (await loadSchedules()).find(
      (candidate) => candidate.id === data.id
    )
    if (!schedule) throw new Error("Schedule not found")
    requireScheduleAuthorization({
      actions: schedule.actions,
      grants,
      schedulePermission: "schedule.execute",
      targets: schedule.targets,
      user,
    })
    await requireScheduleBackupDestinations({
      actions: schedule.actions,
      checkStorageOwnership: false,
      grants,
      targets: schedule.targets,
      user,
    })

    const relays = new Map(
      (await listPersistedRelays()).map((relay) => [relay.id, relay])
    )
    const relayIds = [
      ...new Set(schedule.targets.map((target) => target.relayId)),
    ]
    const results = await Promise.all(
      relayIds.map(async (relayId) => {
        const relay = relays.get(relayId)
        if (!relay?.enabled) {
          return { error: "Relay is unavailable", relayId, started: false }
        }
        const started = await Effect.runPromise(
          Effect.result(
            promiseEffect(() =>
              Promise.resolve(
                relayRpc(
                  relay,
                  "schedule.run",
                  { revision: schedule.revision, scheduleId: schedule.id },
                  15_000,
                  user.id
                )
              ).then((value) => scheduleRunSchema.parse(value))
            )
          )
        )
        if (Result.isFailure(started)) {
          return {
            error: errorMessage(started.failure),
            relayId,
            started: false,
          }
        }
        const imported = await Effect.runPromise(
          Effect.result(
            promiseEffect(() =>
              importScheduleRun(relayId, started.success, Date.now())
            )
          )
        )
        if (Result.isFailure(imported)) {
          console.warn(
            "[Kiln schedules] A started run could not be imported immediately",
            imported.failure
          )
        }
        return { error: null, relayId, started: true }
      })
    )
    publishScheduleCollectionChange(
      results.flatMap((result) => (result.started ? [result.relayId] : []))
    )
    return {
      relays: results,
      started: results.filter((result) => result.started).length,
      total: results.length,
    }
  })

function requireScheduleAuthorization(input: {
  actions: ReadonlyArray<ScheduleAction>
  grants: ReadonlyArray<AccessGrant>
  schedulePermission:
    | "schedule.create"
    | "schedule.delete"
    | "schedule.execute"
    | "schedule.update"
  targets: ReadonlyArray<ScheduleTarget>
  user: AuthenticatedUser
}) {
  const failure = scheduleAuthorizationFailure(input)
  if (failure) throw new Error(failure)
}

async function loadTargetDirectory(): Promise<Array<ScheduleTarget>> {
  const [rows] = await databasePool.query<TargetDirectoryRow[]>(
    // A Relay target is Kiln itself, backed up on that Relay.
    `SELECT relay.id AS id, 'relay' AS kind, 'Kiln' AS name,
            relay.id AS relay_id
       FROM ${databaseTable("relay")} relay
      WHERE relay.enabled = TRUE
      UNION ALL
     SELECT instance.instance_id AS id, 'instance' AS kind,
            COALESCE(instance.display_name, instance.instance_id) AS name,
            instance.relay_id
       FROM ${databaseTable("instance")} instance
       JOIN ${databaseTable("relay")} relay ON relay.id = instance.relay_id
      WHERE relay.enabled = TRUE
      UNION ALL
     SELECT managed.database_id AS id, 'database' AS kind, managed.name,
            managed.relay_id
       FROM ${databaseTable("database")} managed
       JOIN ${databaseTable("relay")} relay ON relay.id = managed.relay_id
      WHERE relay.enabled = TRUE
      ORDER BY relay_id, kind, name`
  )
  return rows.map((row) =>
    scheduleTargetSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      relayId: row.relay_id,
    })
  )
}

async function loadReferencedScheduleTargets(): Promise<Array<ScheduleTarget>> {
  const [rows] = await databasePool.query<TargetDirectoryRow[]>(
    `SELECT DISTINCT target.target_id AS id, target.target_kind AS kind,
            target.target_name AS name, target.relay_id
       FROM ${databaseTable("schedule_target")} target
       JOIN ${databaseTable("schedule")} schedule
         ON schedule.id = target.schedule_id
      WHERE schedule.deleted_at IS NULL
      ORDER BY target.relay_id, target.target_kind, target.target_name`
  )
  return rows.map((row) =>
    scheduleTargetSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      relayId: row.relay_id,
    })
  )
}

async function canonicalTargets(
  requested: ReadonlyArray<ScheduleTarget>
): Promise<Array<ScheduleTarget>> {
  const directory = await loadTargetDirectory()
  const targets = new Map(
    directory.map((target) => [targetKey(target), target])
  )
  return requested.map((target) => {
    const canonical = targets.get(targetKey(target))
    if (!canonical) throw new Error(`${target.name} is no longer available`)
    return canonical
  })
}

// An older Relay rejects the whole projection and keeps running the revision
// it has, so a Relay must advertise support before a schedule turns this on
// for it. Relays that already run it with the option keep it, which lets a
// schedule be disabled or edited while its Relay is offline.
async function requireContinueOnFailureSupport(
  definition: ScheduleDefinition,
  existing?: Pick<ScheduleDefinition, "continueOnFailure" | "targets">
) {
  if (!definition.continueOnFailure) return
  const supported = new Set(
    existing?.continueOnFailure
      ? existing.targets.map((target) => target.relayId)
      : []
  )
  const relayIds = new Set(
    definition.targets
      .map((target) => target.relayId)
      .filter((relayId) => !supported.has(relayId))
  )
  if (relayIds.size === 0) return
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  const unsupported = await Promise.all(
    [...relayIds].map(async (relayId) => {
      const relay = relays.get(relayId)
      if (!relay?.enabled) return relay?.name ?? relayId
      const snapshot = await recoverPromise(
        async () =>
          relaySnapshotSchema.parse(
            await relayRpc(relay, "relay.snapshot", {}, 5_000)
          ),
        () => null
      )
      return snapshot?.node.capabilities.includes(
        "schedule-continue-on-failure"
      )
        ? null
        : relay.name
    })
  )
  const names = unsupported.filter((name) => name !== null)
  if (names.length === 0) return
  throw new Error(
    `Continue on failure needs these Relays online and updated: ${names.join(", ")}`
  )
}

function targetKey(target: ScheduleTarget) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

async function saveNewSchedule(
  schedule: ScheduleDefinition,
  createdBy: string
) {
  await runAppEffect(
    "schedules.create",
    Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      yield* database.transaction("schedules.create", (transaction) =>
        insertSchedule(transaction, schedule, createdBy, now)
      )
    })
  )
}

async function replaceSchedule(
  schedule: ScheduleDefinition,
  expectedRevision: number
) {
  await runAppEffect(
    "schedules.update",
    Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      yield* database.transaction("schedules.update", (transaction) =>
        Effect.gen(function* () {
          const result = yield* transaction.execute(
            `UPDATE ${databaseTable("schedule")}
                SET name = ?, cron_expression = ?, timezone = ?, enabled = ?,
                    continue_on_failure = ?, revision = ?, updated_at = ?
              WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
            [
              schedule.name,
              schedule.cron,
              schedule.timezone,
              schedule.enabled,
              schedule.continueOnFailure === true,
              schedule.revision,
              now,
              schedule.id,
              expectedRevision,
            ]
          )
          if (result.affectedRows !== 1) {
            return yield* new ScheduleRevisionConflictError({
              message:
                "This schedule changed after you opened it. Refresh and try again.",
            })
          }
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("schedule_action")} WHERE schedule_id = ?`,
            [schedule.id]
          )
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("schedule_target")} WHERE schedule_id = ?`,
            [schedule.id]
          )
          yield* insertScheduleParts(transaction, schedule, now)
        })
      )
    })
  )
}


function requestScheduleReconciliation(
  schedules: ReadonlyArray<ScheduleDefinition>
) {
  const now = Date.now()
  if (scheduleReconciliationActive || now < nextScheduleReconciliationAt) {
    return
  }
  scheduleReconciliationActive = true
  nextScheduleReconciliationAt = now + scheduleReconciliationIntervalMs
  forkAppEffect(
    "schedules.reconcileInBackground",
    promiseEffect(() => reconcileSchedules(schedules)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Schedule reconciliation failed", { cause })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          scheduleReconciliationActive = false
        })
      )
    )
  )
}

async function reconcileSchedules(
  schedules: ReadonlyArray<ScheduleDefinition>,
  relayIds?: ReadonlySet<string>
) {
  await reconcileScheduleState(schedules, undefined, relayIds)
  await reconcileScheduleTombstones(undefined, relayIds)
}

async function reconcileScheduleState(
  schedules: ReadonlyArray<ScheduleDefinition>,
  subject?: string,
  relayIds?: ReadonlySet<string>
) {
  const projectionsByRelay = new Map<
    string,
    Array<{ schedule: ScheduleDefinition; targets: Array<ScheduleTarget> }>
  >()
  for (const schedule of schedules) {
    for (const [relayId, targets] of groupRows(
      schedule.targets,
      (target) => target.relayId
    )) {
      if (relayIds && !relayIds.has(relayId)) continue
      const projections = projectionsByRelay.get(relayId) ?? []
      projections.push({ schedule, targets })
      projectionsByRelay.set(relayId, projections)
    }
  }
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  await Effect.runPromise(
    Effect.forEach(
      [...projectionsByRelay],
      ([relayId, projections]) =>
        promiseEffect(async () => {
          const relay = relays.get(relayId)
          if (!relay?.enabled) return
          const reconciled = await Effect.runPromise(
            Effect.result(
              promiseEffect(async () => {
                const overview = relayScheduleOverviewSchema.parse(
                  await relayRpc(
                    relay,
                    "schedule.overview",
                    {
                      scheduleIds: projections.map(
                        ({ schedule }) => schedule.id
                      ),
                    },
                    15_000
                  )
                )
                await importRelayScheduleOverview(relayId, overview)
                const revisions = new Map(
                  overview.deployments.map((deployment) => [
                    deployment.scheduleId,
                    deployment.acknowledgedRevision,
                  ])
                )
                // Those the Relay has the revision of, but an older
                // generation, are owed their admission too.
                const behind = await schedulesBehindOnRelay(relayId)
                await Effect.runPromise(
                  Effect.forEach(
                    projections,
                    ({ schedule, targets }) =>
                      revisions.get(schedule.id) === schedule.revision &&
                      !behind.has(schedule.id)
                        ? Effect.void
                        : promiseEffect(() =>
                            deployScheduleToRelay(
                              schedule,
                              targets,
                              relay,
                              subject
                            )
                          ),
                    {
                      concurrency: scheduleReconciliationConcurrency,
                      discard: true,
                    }
                  )
                )
              })
            )
          )
          if (Result.isFailure(reconciled)) {
            // The last acknowledged next-run and history remain available while a
            // Relay is disconnected. Disconnection is not recorded as a run fail.
            return
          }
        }),
      { concurrency: scheduleReconciliationConcurrency, discard: true }
    )
  )
}

async function reconcileScheduleTombstones(
  subject?: string,
  relayIds?: ReadonlySet<string>
) {
  const [rows] = await databasePool.query<ScheduleTombstoneRow[]>(
    `SELECT deployment.schedule_id, deployment.relay_id,
            deployment.desired_revision
       FROM ${databaseTable("schedule_deployment")} deployment
       JOIN ${databaseTable("schedule")} schedule
         ON schedule.id = deployment.schedule_id
      WHERE schedule.deleted_at IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
             FROM ${databaseTable("schedule_target")} target
            WHERE target.schedule_id = deployment.schedule_id
              AND target.relay_id = deployment.relay_id
         )`
  )
  await Effect.runPromise(
    Effect.forEach(
      rows,
      (row) =>
        relayIds && !relayIds.has(row.relay_id)
          ? Effect.void
          : promiseEffect(() =>
              removeRelayProjections(
                row.schedule_id,
                row.desired_revision,
                [row.relay_id],
                subject
              )
            ),
      { concurrency: scheduleReconciliationConcurrency, discard: true }
    )
  )
}

async function importRelayScheduleOverview(
  relayId: string,
  overview: z.infer<typeof relayScheduleOverviewSchema>
) {
  const [storedDeploymentIds, storedRunIds] = await Promise.all([
    loadStoredScheduleIds(
      "schedule_deployment",
      "schedule_id",
      relayId,
      overview.deployments.map((deployment) => deployment.scheduleId)
    ),
    loadStoredScheduleIds(
      "schedule_run",
      "id",
      relayId,
      overview.runs.map((run) => run.id)
    ),
  ])
  const now = Date.now()
  let changed = false
  for (const deployment of overview.deployments) {
    // updated_at is assigned first so it compares against the stored row and
    // only moves when something changes, keeping affectedRows meaningful.
    // Counted applied by the same rule as a reply to sending it: only
    // once the Relay has the newest revision and generation Hearth issued.
    // A Relay that names no generation has none.
    const [result] = await databasePool.execute<ResultSetHeader>(
      `INSERT INTO ${databaseTable("schedule_deployment")}
         (schedule_id, relay_id, desired_revision, acknowledged_revision,
          acknowledged_generation, status, next_run_at, last_error,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'applied', ?, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         updated_at = IF(
           VALUES(acknowledged_revision) > COALESCE(acknowledged_revision, 0)
             OR VALUES(acknowledged_generation)
               > COALESCE(acknowledged_generation, 0)
             OR (VALUES(acknowledged_revision) >= desired_revision
               AND VALUES(acknowledged_generation) >= desired_generation
               AND NOT (status <=> 'applied'
                 AND next_run_at <=> VALUES(next_run_at)
                 AND last_error IS NULL)),
           VALUES(updated_at), updated_at),
         status = IF(VALUES(acknowledged_revision) >= desired_revision
             AND VALUES(acknowledged_generation) >= desired_generation,
           'applied', status),
         next_run_at = IF(VALUES(acknowledged_revision) >= desired_revision
             AND VALUES(acknowledged_generation) >= desired_generation,
           VALUES(next_run_at), next_run_at),
         last_error = IF(VALUES(acknowledged_revision) >= desired_revision
             AND VALUES(acknowledged_generation) >= desired_generation,
           NULL, last_error),
         acknowledged_generation = GREATEST(
           COALESCE(acknowledged_generation, 0),
           VALUES(acknowledged_generation)),
         acknowledged_revision = GREATEST(
           COALESCE(acknowledged_revision, 0),
           VALUES(acknowledged_revision))`,
      [
        deployment.scheduleId,
        relayId,
        deployment.acknowledgedRevision,
        deployment.acknowledgedRevision,
        deployment.acknowledgedGeneration ?? 0,
        deployment.nextRunAt,
        now,
        now,
      ]
    )
    changed ||=
      !storedDeploymentIds.has(deployment.scheduleId) || result.affectedRows > 1
  }
  for (const run of overview.runs) {
    const result = await importScheduleRun(relayId, run, now)
    changed ||= !storedRunIds.has(run.id) || result.affectedRows > 1
  }
  if (changed) publishScheduleCollectionChange([relayId])
}

async function loadStoredScheduleIds(
  table: "schedule_deployment" | "schedule_run",
  idColumn: "id" | "schedule_id",
  relayId: string,
  ids: ReadonlyArray<string>
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const placeholders = ids.map(() => "?").join(", ")
  const [rows] = await databasePool.query<StoredScheduleIdRow[]>(
    `SELECT ${idColumn} AS id
       FROM ${databaseTable(table)}
      WHERE relay_id = ?
        AND ${idColumn} IN (${placeholders})`,
    [relayId, ...ids]
  )
  return new Set(rows.map((row) => row.id))
}

async function importScheduleRun(
  relayId: string,
  run: ScheduleRun,
  now: number
) {
  // updated_at is assigned first so an unchanged run is not reported as changed.
  const [result] = await databasePool.execute<ResultSetHeader>(
    `INSERT INTO ${databaseTable("schedule_run")}
       (id, schedule_id, relay_id, scheduled_at, status, run_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       updated_at = IF(status <=> VALUES(status)
           AND run_json <=> VALUES(run_json),
         updated_at, VALUES(updated_at)),
       status = VALUES(status),
       run_json = VALUES(run_json)`,
    [
      run.id,
      run.scheduleId,
      relayId,
      run.scheduledAt,
      run.status,
      JSON.stringify(run),
      now,
      now,
    ]
  )
  return result
}

// The schedules a Relay hasn't acknowledged the newest generation of.
async function schedulesBehindOnRelay(relayId: string): Promise<Set<string>> {
  const [rows] = await databasePool.query<
    Array<{ schedule_id: string } & RowDataPacket>
  >(
    `SELECT schedule_id
       FROM ${databaseTable("schedule_deployment")}
      WHERE relay_id = ?
        AND COALESCE(acknowledged_generation, 0) < desired_generation`,
    [relayId]
  )
  return new Set(rows.map((row) => row.schedule_id))
}
