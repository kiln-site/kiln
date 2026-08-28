import { randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { Data, Effect, Result } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  normalizeScheduleCron,
  relayScheduleOverviewSchema,
  scheduleActionAppliesToTarget,
  scheduleActionSchema,
  scheduleDefinitionSchema,
  scheduleInputSchema,
  scheduleRunSchema,
  scheduleTargetSchema,
  type RelayScheduleAction,
  type RelayScheduleProjection,
  type ScheduleAction,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTarget,
} from "@workspace/contracts"

import { prepareResticRepositoryLocation } from "@/backups/destinations"
import {
  backupObjectKeyPrefix,
  loadBackupStorageCredentialEffect,
  loadBackupStorageEffect,
} from "@/backups/destinations/s3"
import { ensureBackupRepositoryEffect } from "@/effect/backups"
import { Database, type DatabaseTransaction } from "@/effect/database"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { kilnInstallationId } from "@/lib/environment"
import {
  hasPlatformPermission,
  isPlatformAdmin,
  listUserGrants,
  type AccessGrant,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  hasScheduleTargetPermission,
  scheduleActionPermission,
  scheduleAuthorizationFailure,
} from "@/lib/schedule-permissions"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { scheduleTargetsWithAvailability } from "@/lib/schedule-target-options"
import { promiseEffect } from "@/effect/promise"
import { requireAuthenticatedUser } from "@/server/auth"

const scheduleWriteSchema = scheduleInputSchema

const scheduleUpdateSchema = scheduleWriteSchema.safeExtend({
  id: z.uuid(),
  revision: z.number().int().positive(),
})
const scheduleIdSchema = z.strictObject({ id: z.uuid() })
const scheduleReconciliationIntervalMs = 60_000
const scheduleReconciliationConcurrency = 4
let scheduleReconciliationActive = false
let nextScheduleReconciliationAt = 0

class ScheduleRevisionConflictError extends Data.TaggedError(
  "ScheduleRevisionConflictError"
)<{ readonly message: string }> {}

interface ScheduleRow extends RowDataPacket {
  created_at: Date
  created_by: string
  cron_expression: string
  enabled: number
  id: string
  name: string
  revision: number
  timezone: string
  updated_at: Date
}

interface ScheduleActionRow extends RowDataPacket {
  action_config: unknown
  action_type: ScheduleAction["type"]
  id: string
  position: number
  schedule_id: string
}

interface ScheduleTargetRow extends RowDataPacket {
  relay_id: string
  schedule_id: string
  target_id: string
  target_kind: ScheduleTarget["kind"]
  target_name: string
}

interface ScheduleDeploymentRow extends RowDataPacket {
  acknowledged_revision: number | null
  desired_revision: number
  last_error: string | null
  next_run_at: Date | null
  relay_id: string
  schedule_id: string
  status: "applied" | "error" | "pending"
}

interface ScheduleRunRow extends RowDataPacket {
  relay_id: string
  run_json: unknown
  schedule_id: string
}

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
    const user = await requireAuthenticatedUser()
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
        const permission = scheduleActionPermission({ type }, target)
        return (
          permission === null ||
          hasScheduleTargetPermission({ grants, permission, target, user })
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
    const user = await requireAuthenticatedUser()
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
    const user = await requireAuthenticatedUser()
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
    await requireScheduleBackupDestinations(definition.actions, user)
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
    const user = await requireAuthenticatedUser()
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
    await requireScheduleBackupDestinations(existing.actions, user)
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
    await requireScheduleBackupDestinations(definition.actions, user)
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
    const user = await requireAuthenticatedUser()
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
    await databasePool.execute(
      `UPDATE ${databaseTable("schedule")}
          SET enabled = FALSE, revision = ?, deleted_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND deleted_at IS NULL`,
      [revision, schedule.id]
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

export const runScheduleNow = createServerFn({ method: "POST" })
  .validator(scheduleIdSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
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
            promiseEffect(() => importScheduleRun(relayId, started.success))
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
    `SELECT relay.id AS id, 'relay' AS kind, relay.name,
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
      yield* database.transaction("schedules.create", (transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("schedule")}
               (id, name, cron_expression, timezone, enabled, revision, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              schedule.id,
              schedule.name,
              schedule.cron,
              schedule.timezone,
              schedule.enabled,
              schedule.revision,
              createdBy,
            ]
          )
          yield* insertScheduleParts(transaction, schedule)
        })
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
      yield* database.transaction("schedules.update", (transaction) =>
        Effect.gen(function* () {
          const result = yield* transaction.execute(
            `UPDATE ${databaseTable("schedule")}
                SET name = ?, cron_expression = ?, timezone = ?, enabled = ?,
                    revision = ?
              WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
            [
              schedule.name,
              schedule.cron,
              schedule.timezone,
              schedule.enabled,
              schedule.revision,
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
          yield* insertScheduleParts(transaction, schedule)
        })
      )
    })
  )
}

function insertScheduleParts(
  transaction: DatabaseTransaction,
  schedule: ScheduleDefinition
) {
  return Effect.gen(function* () {
    for (const [position, action] of schedule.actions.entries()) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("schedule_action")}
           (id, schedule_id, position, action_type, action_config)
         VALUES (?, ?, ?, ?, ?)`,
        [action.id, schedule.id, position, action.type, JSON.stringify(action)]
      )
    }
    for (const target of schedule.targets) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("schedule_target")}
           (schedule_id, relay_id, target_kind, target_id, target_name)
         VALUES (?, ?, ?, ?, ?)`,
        [schedule.id, target.relayId, target.kind, target.id, target.name]
      )
    }
  })
}

async function loadSchedules() {
  const [scheduleRows, actionRows, targetRows, deploymentRows, runRows] =
    await Promise.all([
      databasePool.query<ScheduleRow[]>(
        `SELECT id, name, cron_expression, timezone, enabled, revision,
                created_by, created_at, updated_at
           FROM ${databaseTable("schedule")}
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC`
      ),
      databasePool.query<ScheduleActionRow[]>(
        `SELECT id, schedule_id, position, action_type, action_config
           FROM ${databaseTable("schedule_action")}
          ORDER BY schedule_id, position`
      ),
      databasePool.query<ScheduleTargetRow[]>(
        `SELECT schedule_id, relay_id, target_kind, target_id, target_name
           FROM ${databaseTable("schedule_target")}
          ORDER BY schedule_id, relay_id, target_kind, target_name`
      ),
      databasePool.query<ScheduleDeploymentRow[]>(
        `SELECT schedule_id, relay_id, desired_revision,
                acknowledged_revision, status, next_run_at, last_error
           FROM ${databaseTable("schedule_deployment")}`
      ),
      databasePool.query<ScheduleRunRow[]>(
        `SELECT schedule_id, relay_id, run_json
           FROM ${databaseTable("schedule_run")}
          ORDER BY scheduled_at DESC
          LIMIT 1000`
      ),
    ])
  const actionsBySchedule = groupRows(actionRows[0], (row) => row.schedule_id)
  const targetsBySchedule = groupRows(targetRows[0], (row) => row.schedule_id)
  const deploymentsBySchedule = groupRows(
    deploymentRows[0],
    (row) => row.schedule_id
  )
  const runsBySchedule = groupRows(runRows[0], (row) => row.schedule_id)
  return scheduleRows[0].map((row) => {
    const definition = scheduleDefinitionSchema.parse({
      actions: (actionsBySchedule.get(row.id) ?? []).map((action) =>
        scheduleActionSchema.parse(jsonValue(action.action_config))
      ),
      cron: row.cron_expression,
      enabled: Boolean(row.enabled),
      id: row.id,
      name: row.name,
      revision: row.revision,
      targets: (targetsBySchedule.get(row.id) ?? []).map((target) => ({
        id: target.target_id,
        kind: target.target_kind,
        name: target.target_name,
        relayId: target.relay_id,
      })),
      timezone: row.timezone,
    })
    return {
      ...definition,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
      deployments: (deploymentsBySchedule.get(row.id) ?? []).map(
        (deployment) => ({
          acknowledgedRevision: deployment.acknowledged_revision,
          desiredRevision: deployment.desired_revision,
          lastError: deployment.last_error,
          nextRunAt: deployment.next_run_at?.toISOString() ?? null,
          relayId: deployment.relay_id,
          status: deployment.status,
        })
      ),
      runs: (runsBySchedule.get(row.id) ?? []).flatMap((run) => {
        const parsed = scheduleRunSchema.safeParse(jsonValue(run.run_json))
        return parsed.success ? [{ ...parsed.data, relayId: run.relay_id }] : []
      }),
      updatedAt: row.updated_at.toISOString(),
    }
  })
}

function groupRows<TRow>(
  rows: ReadonlyArray<TRow>,
  key: (row: TRow) => string
) {
  const grouped = new Map<string, Array<TRow>>()
  for (const row of rows) {
    const value = key(row)
    const entries = grouped.get(value) ?? []
    entries.push(row)
    grouped.set(value, entries)
  }
  return grouped
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

async function deploySchedule(schedule: ScheduleDefinition, subject: string) {
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  const targetsByRelay = groupRows(schedule.targets, (target) => target.relayId)
  await Promise.all(
    [...targetsByRelay].map(async ([relayId, targets]) => {
      const relay = relays.get(relayId)
      await deployScheduleToRelay(schedule, targets, relay, subject)
    })
  )
}

async function deployScheduleToRelay(
  schedule: ScheduleDefinition,
  targets: ReadonlyArray<ScheduleTarget>,
  relay: Awaited<ReturnType<typeof listPersistedRelays>>[number] | undefined,
  subject?: string
) {
  const relayId = targets[0]?.relayId
  if (!relayId) return
  await upsertDeployment(schedule.id, relayId, schedule.revision, "pending")
  if (!relay?.enabled) {
    await deploymentError(
      schedule.id,
      relayId,
      schedule.revision,
      "Relay is unavailable"
    )
    return
  }
  const deployed = await Effect.runPromise(
    Effect.result(
      promiseEffect(async () => {
        const projection: RelayScheduleProjection = {
          ...schedule,
          actions: await prepareRelayScheduleActions(schedule.actions, targets),
          targets: [...targets],
        }
        const result = z
          .object({
            acknowledgedRevision: z.number().int().positive(),
            nextRunAt: z.number().int().nonnegative().nullable(),
            scheduleId: z.uuid(),
          })
          .parse(
            await relayRpc(relay, "schedule.apply", projection, 15_000, subject)
          )
        await databasePool.execute(
          `UPDATE ${databaseTable("schedule_deployment")}
          SET status = IF(? >= desired_revision, 'applied', status),
              next_run_at = IF(? >= desired_revision,
                FROM_UNIXTIME(? / 1000), next_run_at),
              last_error = IF(? >= desired_revision, NULL, last_error),
              acknowledged_revision = GREATEST(
                COALESCE(acknowledged_revision, 0), ?)
        WHERE schedule_id = ? AND relay_id = ?`,
          [
            result.acknowledgedRevision,
            result.acknowledgedRevision,
            result.nextRunAt,
            result.acknowledgedRevision,
            result.acknowledgedRevision,
            schedule.id,
            relayId,
          ]
        )
      })
    )
  )
  if (Result.isFailure(deployed)) {
    await deploymentError(
      schedule.id,
      relayId,
      schedule.revision,
      errorMessage(deployed.failure)
    )
  }
}

async function prepareRelayScheduleActions(
  actions: ReadonlyArray<ScheduleAction>,
  targets: ReadonlyArray<ScheduleTarget>
): Promise<Array<RelayScheduleAction>> {
  return Effect.runPromise(
    Effect.forEach(
      actions,
      (action): Effect.Effect<RelayScheduleAction, unknown> => {
        if (action.type !== "backup") return Effect.succeed(action)
        return Effect.forEach(
          targets,
          (target) =>
            !scheduleActionAppliesToTarget(action, target)
              ? Effect.succeed(null)
              : promiseEffect(async () => ({
                  destination:
                    action.mode === "full"
                      ? await scheduledFullBackupDestination(action, target)
                      : await scheduledResticDestination(action, target),
                  mode: action.mode,
                  targetId: target.id,
                  targetKind: target.kind,
                })),
          { concurrency: scheduleReconciliationConcurrency }
        ).pipe(
          Effect.map((executions) => ({
            ...action,
            executions: executions.flatMap((execution) =>
              execution ? [execution] : []
            ),
          }))
        )
      },
      { concurrency: 1 }
    )
  )
}

async function scheduledFullBackupDestination(
  action: Extract<ScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
) {
  if (action.destination.kind === "local") {
    return { kind: "local" as const }
  }
  const storage = await runAppEffect(
    "schedules.loadBackupStorageCredential",
    loadBackupStorageCredentialEffect(action.destination.storageId)
  )
  if (!storage || !storage.enabled || storage.deleting) {
    throw new Error("Backup destination is unavailable")
  }
  const installationId = kilnInstallationId()
  const targetKind = target.kind === "relay" ? "platform" : target.kind
  return {
    accessKeyId: storage.accessKeyId,
    allowPrivateNetwork: storage.allowPrivateNetwork,
    bucket: storage.bucket,
    endpoint: storage.endpoint,
    forcePathStyle: storage.forcePathStyle,
    kind: "s3" as const,
    objectKeyPrefix: backupObjectKeyPrefix({
      installationId,
      objectPrefix: storage.objectPrefix,
      relayId: target.relayId,
      targetId: targetKind === "platform" ? installationId : target.id,
      targetKind,
    }),
    region: storage.region,
    secretAccessKey: storage.secretAccessKey,
  }
}

async function scheduledResticDestination(
  action: Extract<ScheduleAction, { type: "backup" }>,
  target: ScheduleTarget
) {
  const storageId =
    action.destination.kind === "storage" ? action.destination.storageId : null
  const repository = await runAppEffect(
    "schedules.ensureBackupRepository",
    ensureBackupRepositoryEffect({
      relayId: target.relayId,
      storageId,
      targetId: target.id,
    })
  )
  const location = await runAppEffect(
    "schedules.prepareBackupRepository",
    Effect.suspend(() =>
      prepareResticRepositoryLocation({
        objectPrefix: repository.objectPrefix,
        requireEnabled: true,
        storageId: repository.storageId,
      })
    )
  )
  return {
    kind: "restic" as const,
    repository: location,
    repositoryPassword: repository.password,
  }
}

async function requireScheduleBackupDestinations(
  actions: ReadonlyArray<ScheduleAction>,
  user: AuthenticatedUser
) {
  const backupActions = actions.filter(
    (action): action is Extract<ScheduleAction, { type: "backup" }> =>
      action.type === "backup"
  )
  const storageIds = [
    ...new Set(
      backupActions.flatMap((action) =>
        action.destination.kind === "storage"
          ? [action.destination.storageId]
          : []
      )
    ),
  ]
  await Promise.all(
    storageIds.map(async (storageId) => {
      const storage = await runAppEffect(
        "schedules.loadBackupStorage",
        loadBackupStorageEffect(storageId)
      )
      if (
        !storage ||
        !storage.enabled ||
        storage.deleting ||
        (storage.ownerUserId !== null &&
          storage.ownerUserId !== user.id &&
          !hasPlatformPermission(user, "platform.backups.manage-storage"))
      ) {
        throw new Error("Backup destination is unavailable")
      }
    })
  )
}

async function removeRelayProjections(
  scheduleId: string,
  revision: number,
  relayIds: ReadonlyArray<string>,
  subject?: string
) {
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  await Promise.all(
    relayIds.map(async (relayId) => {
      await upsertDeployment(scheduleId, relayId, revision, "pending")
      const relay = relays.get(relayId)
      if (!relay?.enabled) {
        await deploymentError(
          scheduleId,
          relayId,
          revision,
          "Relay is unavailable"
        )
        return
      }
      const removed = await Effect.runPromise(
        Effect.result(
          promiseEffect(async () => {
            await relayRpc(
              relay,
              "schedule.remove",
              { revision, scheduleId },
              15_000,
              subject
            )
            await databasePool.execute(
              `DELETE FROM ${databaseTable("schedule_deployment")}
            WHERE schedule_id = ? AND relay_id = ?`,
              [scheduleId, relayId]
            )
          })
        )
      )
      if (Result.isFailure(removed)) {
        await deploymentError(
          scheduleId,
          relayId,
          revision,
          errorMessage(removed.failure)
        )
      }
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
                await Effect.runPromise(
                  Effect.forEach(
                    projections,
                    ({ schedule, targets }) =>
                      revisions.get(schedule.id) === schedule.revision
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
  let changed = false
  for (const deployment of overview.deployments) {
    const [result] = await databasePool.execute<ResultSetHeader>(
      `INSERT INTO ${databaseTable("schedule_deployment")}
         (schedule_id, relay_id, desired_revision, acknowledged_revision,
          status, next_run_at, last_error)
       VALUES (?, ?, ?, ?, 'applied', FROM_UNIXTIME(? / 1000), NULL)
       ON DUPLICATE KEY UPDATE
         status = IF(VALUES(acknowledged_revision) >= desired_revision,
           'applied', status),
         next_run_at = IF(VALUES(acknowledged_revision) >= desired_revision,
           VALUES(next_run_at), next_run_at),
         last_error = IF(VALUES(acknowledged_revision) >= desired_revision,
           NULL, last_error),
         acknowledged_revision = GREATEST(
           COALESCE(acknowledged_revision, 0),
           VALUES(acknowledged_revision))`,
      [
        deployment.scheduleId,
        relayId,
        deployment.acknowledgedRevision,
        deployment.acknowledgedRevision,
        deployment.nextRunAt,
      ]
    )
    changed ||=
      !storedDeploymentIds.has(deployment.scheduleId) || result.affectedRows > 1
  }
  for (const run of overview.runs) {
    const result = await importScheduleRun(relayId, run)
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

function publishScheduleCollectionChange(relayIds: Iterable<string>): void {
  const uniqueRelayIds = [...new Set(relayIds)]
  if (uniqueRelayIds.length === 0) return
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: uniqueRelayIds },
    topics: ["schedules"],
    type: "hearth.invalidate",
  })
}

async function importScheduleRun(relayId: string, run: ScheduleRun) {
  const [result] = await databasePool.execute<ResultSetHeader>(
    `INSERT INTO ${databaseTable("schedule_run")}
       (id, schedule_id, relay_id, scheduled_at, status, run_json)
     VALUES (?, ?, ?, FROM_UNIXTIME(? / 1000), ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status),
       run_json = VALUES(run_json)`,
    [
      run.id,
      run.scheduleId,
      relayId,
      run.scheduledAt,
      run.status,
      JSON.stringify(run),
    ]
  )
  return result
}

async function upsertDeployment(
  scheduleId: string,
  relayId: string,
  revision: number,
  status: "pending"
) {
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = IF(VALUES(desired_revision) >= desired_revision,
         VALUES(status), status),
       last_error = IF(VALUES(desired_revision) >= desired_revision,
         NULL, last_error),
       desired_revision = GREATEST(desired_revision,
         VALUES(desired_revision))`,
    [scheduleId, relayId, revision, status]
  )
}

async function deploymentError(
  scheduleId: string,
  relayId: string,
  revision: number,
  error: string
) {
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status, last_error)
     VALUES (?, ?, ?, 'error', ?)
     ON DUPLICATE KEY UPDATE
       status = IF(VALUES(desired_revision) >= desired_revision,
         'error', status),
       last_error = IF(VALUES(desired_revision) >= desired_revision,
         VALUES(last_error), last_error),
       desired_revision = GREATEST(desired_revision,
         VALUES(desired_revision))`,
    [scheduleId, relayId, revision, error.slice(0, 2_000)]
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown Relay error"
}
