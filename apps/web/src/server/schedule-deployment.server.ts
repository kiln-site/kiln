import { randomUUID } from "node:crypto"

import { Clock, Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  scheduleActionAppliesToTarget,
  scheduleActionSchema,
  scheduleDefinitionSchema,
  scheduleRunSchema,
  type RelayScheduleAction,
  type RelayScheduleProjection,
  type ScheduleAction,
  type ScheduleDefinition,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"

import { prepareResticRepositoryLocation } from "@/backups/destinations"
import {
  backupObjectKeyPrefix,
  loadBackupStorageCredentialEffect,
} from "@/backups/destinations/s3"
import { ensureBackupRepositoryEffect } from "@/effect/backups"
import { Database, type DatabaseTransaction } from "@/effect/database"
import { kilnInstallationId } from "@/effect/installation"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { defaultKilnBackupsSettingId } from "@/migrations/0024_default_kiln_backups"

// Saving schedules and handing them to their Relays, shared by the schedule
// server functions and the work Hearth does on its own, such as creating a
// fresh installation's Kiln backups.

export const scheduleReconciliationConcurrency = 4

export function insertSchedule(
  transaction: DatabaseTransaction,
  schedule: ScheduleDefinition,
  createdBy: string,
  now: number
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `INSERT INTO ${databaseTable("schedule")}
         (id, name, cron_expression, timezone, enabled,
          continue_on_failure, revision, created_by, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        schedule.id,
        schedule.name,
        schedule.cron,
        schedule.timezone,
        schedule.enabled,
        schedule.continueOnFailure === true,
        schedule.revision,
        createdBy,
        now,
        now,
      ]
    )
    yield* insertScheduleParts(transaction, schedule, now)
  })
}

// What a fresh installation's daily Kiln backup keeps.
const defaultKilnBackupRetention = { bytes: 20 * 1024 ** 3, days: 30 }

interface SettingValueRow extends RowDataPacket {
  setting_value: unknown
}

/**
 * Creates the daily Kiln backup a fresh installation starts with, once it
 * has an administrator to own it and the Relay on Kiln's host is connected.
 * The installation is marked when its database is first migrated (migration
 * 24); the mark is cleared once the schedule exists, so deleting it sticks.
 */
export async function seedDefaultKilnBackupSchedule(): Promise<string | null> {
  if (!(await defaultKilnBackupsPending())) return null
  // Only a Relay that reports this installation backs it up: another Kiln
  // can run beside it.
  const installationId = kilnInstallationId()
  const [{ kilnPlatformHosts }, { selectKilnHost }] = await Promise.all([
    import("@/server/platform-access.server"),
    import("@/lib/kiln-host"),
  ])
  const own = (await kilnPlatformHosts()).filter(
    (host) => host.status?.installationId === installationId
  )
  const kilnHost = selectKilnHost({ hosts: own, installationId })
  if (!kilnHost) return null
  const { relayId } = kilnHost
  const schedule = scheduleDefinitionSchema.parse({
    actions: [
      {
        destination: { kind: "local" },
        id: randomUUID(),
        mode: "full",
        name: "Kiln backup",
        retention: defaultKilnBackupRetention,
        type: "backup",
      },
    ],
    cron: "0 3 * * *",
    enabled: true,
    id: randomUUID(),
    name: "Kiln backups",
    revision: 1,
    targets: [{ id: relayId, kind: "relay", name: "Kiln", relayId }],
    timezone: "UTC",
  })
  const owner = await runAppEffect(
    "schedules.seedKilnBackups",
    Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      return yield* database.transaction(
        "schedules.seedKilnBackups",
        (transaction) =>
          Effect.gen(function* () {
            const [marker] = yield* transaction.queryRows<SettingValueRow>(
              `SELECT setting_value FROM ${databaseTable("setting")}
                WHERE id = ? FOR UPDATE`,
              [defaultKilnBackupsSettingId]
            )
            if (!isPendingMarker(marker?.setting_value)) return null
            const [admin] = yield* transaction.queryRows<
              { id: string } & RowDataPacket
            >(
              `SELECT id FROM ${databaseTable("user")}
                WHERE role = 'admin'
                ORDER BY createdAt ASC, id ASC
                LIMIT 1`
            )
            if (!admin) return null
            yield* insertSchedule(transaction, schedule, admin.id, now)
            // Pending until the Relay takes it, so a sweep resends it even
            // if Hearth stops before the first send.
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("schedule_deployment")}
                 (schedule_id, relay_id, desired_revision, status,
                  created_at, updated_at)
               VALUES (?, ?, ?, 'pending', ?, ?)`,
              [schedule.id, relayId, schedule.revision, now, now]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("setting")}
                  SET setting_value = ?, updated_at = ?
                WHERE id = ?`,
              [
                JSON.stringify({ scheduleId: schedule.id, state: "created" }),
                now,
                defaultKilnBackupsSettingId,
              ]
            )
            return admin.id
          })
      )
    })
  )
  if (!owner) return null
  await deploySchedule(schedule, owner)
  publishScheduleCollectionChange([relayId])
  return schedule.id
}

async function defaultKilnBackupsPending(): Promise<boolean> {
  const [rows] = await databasePool.query<SettingValueRow[]>(
    `SELECT setting_value FROM ${databaseTable("setting")} WHERE id = ?`,
    [defaultKilnBackupsSettingId]
  )
  return isPendingMarker(rows[0]?.setting_value)
}

function isPendingMarker(value: unknown): boolean {
  const parsed = z
    .object({ state: z.string() })
    .safeParse(jsonValue(value ?? null))
  return parsed.success && parsed.data.state === "pending"
}

export function insertScheduleParts(
  transaction: DatabaseTransaction,
  schedule: ScheduleDefinition,
  now: number
) {
  return Effect.gen(function* () {
    for (const [position, action] of schedule.actions.entries()) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("schedule_action")}
           (id, schedule_id, position, action_type, action_config, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          action.id,
          schedule.id,
          position,
          action.type,
          JSON.stringify(action),
          now,
        ]
      )
    }
    for (const target of schedule.targets) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("schedule_target")}
           (schedule_id, relay_id, target_kind, target_id, target_name,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [schedule.id, target.relayId, target.kind, target.id, target.name, now]
      )
    }
  })
}

export function groupRows<TRow>(
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

export function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}

export async function deploySchedule(
  schedule: ScheduleDefinition,
  subject: string
) {
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

export async function deployScheduleToRelay(
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
        // Field by field: callers can pass a loaded schedule, with Hearth's
        // own fields, and Relays reject keys they don't know.
        const projection: RelayScheduleProjection = {
          actions: await prepareRelayScheduleActions(schedule.actions, targets),
          // Older Relays reject unknown keys, so only send the option when on.
          ...(schedule.continueOnFailure ? { continueOnFailure: true } : {}),
          cron: schedule.cron,
          enabled: schedule.enabled,
          id: schedule.id,
          name: schedule.name,
          revision: schedule.revision,
          targets: [...targets],
          timezone: schedule.timezone,
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
              next_run_at = IF(? >= desired_revision, ?, next_run_at),
              last_error = IF(? >= desired_revision, NULL, last_error),
              acknowledged_revision = GREATEST(
                COALESCE(acknowledged_revision, 0), ?),
              updated_at = ?
        WHERE schedule_id = ? AND relay_id = ?`,
          [
            result.acknowledgedRevision,
            result.acknowledgedRevision,
            result.nextRunAt,
            result.acknowledgedRevision,
            result.acknowledgedRevision,
            Date.now(),
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
            ...relayBackupAction(action),
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

// Retention is Hearth's to apply, and Relays reject keys they don't know.
function relayBackupAction(
  action: Extract<ScheduleAction, { type: "backup" }>
): Omit<Extract<ScheduleAction, { type: "backup" }>, "retention"> {
  const { retention: _, ...relayAction } = action
  return relayAction
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

export function publishScheduleCollectionChange(
  relayIds: Iterable<string>
): void {
  const uniqueRelayIds = [...new Set(relayIds)]
  if (uniqueRelayIds.length === 0) return
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: uniqueRelayIds },
    topics: ["schedules"],
    type: "hearth.invalidate",
  })
}

export async function upsertDeployment(
  scheduleId: string,
  relayId: string,
  revision: number,
  status: "pending"
) {
  const now = Date.now()
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status, created_at,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = IF(VALUES(desired_revision) >= desired_revision,
         VALUES(status), status),
       last_error = IF(VALUES(desired_revision) >= desired_revision,
         NULL, last_error),
       desired_revision = GREATEST(desired_revision,
         VALUES(desired_revision)),
       updated_at = VALUES(updated_at)`,
    [scheduleId, relayId, revision, status, now, now]
  )
}

export async function deploymentError(
  scheduleId: string,
  relayId: string,
  revision: number,
  error: string
) {
  const now = Date.now()
  await databasePool.execute(
    `INSERT INTO ${databaseTable("schedule_deployment")}
       (schedule_id, relay_id, desired_revision, status, last_error,
        created_at, updated_at)
     VALUES (?, ?, ?, 'error', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = IF(VALUES(desired_revision) >= desired_revision,
         'error', status),
       last_error = IF(VALUES(desired_revision) >= desired_revision,
         VALUES(last_error), last_error),
       desired_revision = GREATEST(desired_revision,
         VALUES(desired_revision)),
       updated_at = VALUES(updated_at)`,
    [scheduleId, relayId, revision, error.slice(0, 2_000), now, now]
  )
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Unknown Relay error"
}

export interface ScheduleRow extends RowDataPacket {
  continue_on_failure: number
  created_at: number
  created_by: string
  cron_expression: string
  enabled: number
  id: string
  name: string
  revision: number
  timezone: string
  updated_at: number
}

export interface ScheduleActionRow extends RowDataPacket {
  action_config: unknown
  action_type: ScheduleAction["type"]
  id: string
  position: number
  schedule_id: string
}

export interface ScheduleTargetRow extends RowDataPacket {
  relay_id: string
  schedule_id: string
  target_id: string
  target_kind: ScheduleTarget["kind"]
  target_name: string
}

export interface ScheduleDeploymentRow extends RowDataPacket {
  acknowledged_revision: number | null
  desired_revision: number
  last_error: string | null
  next_run_at: number | null
  relay_id: string
  schedule_id: string
  status: "applied" | "error" | "pending"
}

export interface ScheduleRunRow extends RowDataPacket {
  relay_id: string
  run_json: unknown
  schedule_id: string
}

export async function loadSchedules() {
  const [scheduleRows, actionRows, targetRows, deploymentRows, runRows] =
    await Promise.all([
      databasePool.query<ScheduleRow[]>(
        `SELECT id, name, cron_expression, timezone, enabled,
                continue_on_failure, revision, created_by, created_at,
                updated_at
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
      continueOnFailure: Boolean(row.continue_on_failure),
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
      createdAt: new Date(row.created_at).toISOString(),
      createdBy: row.created_by,
      deployments: (deploymentsBySchedule.get(row.id) ?? []).map(
        (deployment) => ({
          acknowledgedRevision: deployment.acknowledged_revision,
          desiredRevision: deployment.desired_revision,
          lastError: deployment.last_error,
          nextRunAt:
            deployment.next_run_at === null
              ? null
              : new Date(deployment.next_run_at).toISOString(),
          relayId: deployment.relay_id,
          status: deployment.status,
        })
      ),
      runs: (runsBySchedule.get(row.id) ?? []).flatMap((run) => {
        const parsed = scheduleRunSchema.safeParse(jsonValue(run.run_json))
        return parsed.success ? [{ ...parsed.data, relayId: run.relay_id }] : []
      }),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  })
}

/**
 * Sends each Relay the schedules it hasn't acknowledged, as reconciling on
 * the Schedules page does, so a deploy that failed, such as a fresh
 * installation's first, is retried without anyone opening it.
 */
export async function redeployUnacknowledgedSchedules(): Promise<void> {
  const [rows] = await databasePool.query<
    Array<{ relay_id: string; schedule_id: string } & RowDataPacket>
  >(
    `SELECT deployment.schedule_id, deployment.relay_id
       FROM ${databaseTable("schedule_deployment")} deployment
       JOIN ${databaseTable("schedule")} schedule
         ON schedule.id = deployment.schedule_id
        AND schedule.deleted_at IS NULL
      WHERE deployment.status <> 'applied'
         OR COALESCE(deployment.acknowledged_revision, 0)
              < deployment.desired_revision`
  )
  if (rows.length === 0) return
  const [schedules, relays] = await Promise.all([
    loadSchedules().then(
      (loaded) => new Map(loaded.map((schedule) => [schedule.id, schedule]))
    ),
    listPersistedRelays().then(
      (persisted) => new Map(persisted.map((relay) => [relay.id, relay]))
    ),
  ])
  for (const row of rows) {
    const schedule = schedules.get(row.schedule_id)
    const relay = relays.get(row.relay_id)
    if (!schedule || !relay?.enabled) continue
    const targets = schedule.targets.filter(
      (target) => target.relayId === row.relay_id
    )
    if (targets.length > 0) {
      await deployScheduleToRelay(schedule, targets, relay)
    }
  }
}
