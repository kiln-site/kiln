import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import {
  scheduleActionAppliesToTarget,
  scheduleActionSchema,
  scheduleTargetSchema,
  type ScheduleBackupRetention,
} from "@workspace/contracts/schedules"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// A schedule's backup action can keep its backups of each target for a
// number of days, up to a total size, or both. Hearth works out which of
// them have aged or outgrown it; the newest is always kept, so a target
// never loses its last scheduled backup to retention.

const DAY_MS = 24 * 60 * 60_000
const keepEverything: ScheduleBackupRetention = { bytes: null, days: null }

interface ScheduleActionRow extends RowDataPacket {
  action_config: unknown
  schedule_id: string
}

interface ScheduleTargetRow extends RowDataPacket {
  relay_id: string
  schedule_id: string
  target_id: string
  target_kind: string
  target_name: string
}

interface RetainedBackupRow extends RowDataPacket {
  bytes: number | string | null
  created_at: number | string
  // Copied to another destination too, so retention leaves it be.
  elsewhere: number | string
  id: string
}

/** The scheduled backups one action keeps for a target at a destination. */
interface RetentionScope {
  mode: "full" | "incremental"
  relayId: string
  retention: ScheduleBackupRetention
  storageId: string | null
  targetId: string
  targetKind: "database" | "instance" | "platform"
}

export interface ExpiredBackup {
  backupId: string
  relayId: string
  /** The destination its schedule keeps it at; `null` is the Relay. */
  storageId: string | null
}

/** Relays that some schedule backs something up on. */
export const scheduledBackupRelayIdsEffect = Effect.fn(
  "backups.scheduledBackupRelays"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<{ relay_id: string } & RowDataPacket>(
    "backup_retention_relays",
    `SELECT DISTINCT target.relay_id
       FROM ${databaseTable("schedule_target")} target
       JOIN ${databaseTable("schedule")} schedule
         ON schedule.id = target.schedule_id AND schedule.deleted_at IS NULL
       JOIN ${databaseTable("schedule_action")} action
         ON action.schedule_id = schedule.id AND action.action_type = 'backup'`
  )
  return rows.map((row) => row.relay_id)
})

/**
 * Scheduled backups past their schedule's retention, oldest first. Where two
 * schedules back up the same target to the same place, the more generous
 * retention applies to both.
 */
export const expiredScheduledBackupsEffect = Effect.fn(
  "backups.expiredScheduled"
)(function* (input: { installationId: string; now: number }) {
  const database = yield* Database
  const [actions, targets] = yield* Effect.all([
    database.queryRows<ScheduleActionRow>(
      "backup_retention_actions",
      `SELECT action.schedule_id, action.action_config
         FROM ${databaseTable("schedule_action")} action
         JOIN ${databaseTable("schedule")} schedule
           ON schedule.id = action.schedule_id AND schedule.deleted_at IS NULL
        WHERE action.action_type = 'backup'`
    ),
    database.queryRows<ScheduleTargetRow>(
      "backup_retention_targets",
      `SELECT target.schedule_id, target.relay_id, target.target_kind,
              target.target_id, target.target_name
         FROM ${databaseTable("schedule_target")} target
         JOIN ${databaseTable("schedule")} schedule
           ON schedule.id = target.schedule_id AND schedule.deleted_at IS NULL`
    ),
  ])
  const scopes = new Map<string, RetentionScope>()
  for (const row of actions) {
    const action = scheduleActionSchema.safeParse(jsonValue(row.action_config))
    if (!action.success || action.data.type !== "backup") continue
    // One without retention keeps everything it shares a scope with: a
    // backup doesn't record which schedule made it.
    const retention = action.data.retention ?? keepEverything
    for (const targetRow of targets) {
      if (targetRow.schedule_id !== row.schedule_id) continue
      const target = scheduleTargetSchema.safeParse({
        id: targetRow.target_id,
        kind: targetRow.target_kind,
        name: targetRow.target_name,
        relayId: targetRow.relay_id,
      })
      if (
        !target.success ||
        !scheduleActionAppliesToTarget(action.data, target.data)
      ) {
        continue
      }
      // A Relay target is Kiln's own backup, made on that Relay.
      const scope: RetentionScope = {
        mode: action.data.mode,
        relayId: target.data.relayId,
        retention,
        storageId:
          action.data.destination.kind === "storage"
            ? action.data.destination.storageId
            : null,
        targetId:
          target.data.kind === "relay" ? input.installationId : target.data.id,
        targetKind:
          target.data.kind === "relay" ? "platform" : target.data.kind,
      }
      const key = [
        scope.relayId,
        scope.targetKind,
        scope.targetId,
        scope.storageId ?? "local",
        scope.mode,
      ].join(":")
      const existing = scopes.get(key)
      scopes.set(
        key,
        existing
          ? {
              ...scope,
              retention: moreGenerous(existing.retention, retention),
            }
          : scope
      )
    }
  }

  const expired: Array<ExpiredBackup & { createdAt: number }> = []
  for (const scope of scopes.values()) {
    if (scope.retention.days === null && scope.retention.bytes === null) {
      continue
    }
    const backups = yield* database.queryRows<RetainedBackupRow>(
      "backup_retention_backups",
      `SELECT backup.id, backup.created_at, backup.bytes,
              EXISTS (
                SELECT 1
                  FROM ${databaseTable("backup_artifact")} artifact
                 WHERE artifact.backup_id = backup.id
                   AND artifact.status NOT IN ('deleted', 'failed')
                   AND NOT (artifact.storage_id <=> ?)
              ) AS elsewhere
         FROM ${databaseTable("backup")} backup
        WHERE backup.relay_id = ? AND backup.target_kind = ?
          AND backup.target_id = ?
          AND backup.reason = 'scheduled' AND backup.status = 'available'
          AND backup.storage_id <=> ? AND backup.backup_mode = ?
        ORDER BY backup.created_at DESC, backup.id DESC`,
      [
        scope.storageId,
        scope.relayId,
        scope.targetKind,
        scope.targetId,
        scope.storageId,
        scope.mode,
      ]
    )
    for (const backup of expiredBackups(backups, scope.retention, input.now)) {
      expired.push({
        backupId: backup.id,
        createdAt: Number(backup.created_at),
        relayId: scope.relayId,
        storageId: scope.storageId,
      })
    }
  }
  return expired
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((backup): ExpiredBackup => ({
      backupId: backup.backupId,
      relayId: backup.relayId,
      storageId: backup.storageId,
    }))
})

// Newest first: the newest stays, then each is kept while it is young
// enough and fits in what's left of the size. Deleting a backup deletes
// every copy of it, so one also copied elsewhere, which that destination's
// own keeping covers, is never deleted here; it still counts toward the size.
function expiredBackups(
  backups: ReadonlyArray<RetainedBackupRow>,
  retention: ScheduleBackupRetention,
  now: number
): Array<RetainedBackupRow> {
  const oldest = retention.days === null ? null : now - retention.days * DAY_MS
  let total = 0
  return backups.filter((backup, index) => {
    total += Number(backup.bytes ?? 0)
    if (index === 0 || Number(backup.elsewhere) === 1) return false
    return (
      (oldest !== null && Number(backup.created_at) < oldest) ||
      (retention.bytes !== null && total > retention.bytes)
    )
  })
}

function moreGenerous(
  left: ScheduleBackupRetention,
  right: ScheduleBackupRetention
): ScheduleBackupRetention {
  return {
    bytes:
      left.bytes === null || right.bytes === null
        ? null
        : Math.max(left.bytes, right.bytes),
    days:
      left.days === null || right.days === null
        ? null
        : Math.max(left.days, right.days),
  }
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value
}
