import { randomUUID } from "node:crypto"

import { Clock, Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  scheduleActionAppliesToTarget,
  scheduleDefinitionSchema,
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
  const [{ platformRelays }, { relayConnectionPlatform }] = await Promise.all([
    import("@/server/platform-access.server"),
    import("@/lib/relay-connection"),
  ])
  const relays = await platformRelays()
  // The Relay that installed Kiln, else one that only reports it.
  const host =
    relays.find((relay) => relayConnectionPlatform(relay.id) === "relay") ??
    relays[0]
  if (!host) return null
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
    targets: [{ id: host.id, kind: "relay", name: "Kiln", relayId: host.id }],
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
  publishScheduleCollectionChange([host.id])
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
        const { continueOnFailure, ...definition } = schedule
        const projection: RelayScheduleProjection = {
          ...definition,
          // Older Relays reject unknown keys, so only send the option when on.
          ...(continueOnFailure ? { continueOnFailure } : {}),
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
