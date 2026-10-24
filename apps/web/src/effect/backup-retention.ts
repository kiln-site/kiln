import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// A target's backup policy is its retention: it keeps its newest backups,
// up to a number of them, the space they take together, and an age, each
// the lower of the owner's limit and a platform administrator's ceiling.
// Hearth deletes the rest, oldest first. The newest backup is always kept,
// so retention never leaves a target without one, and final-deletion
// backups, the last of a deleted server or database, are never deleted.

const DAY_MS = 24 * 60 * 60_000

interface RetentionPolicyRow extends RowDataPacket {
  admin_quantity_limit: number | null
  admin_retention_days: number | null
  admin_size_limit_bytes: number | string | null
  quantity_limit: number | null
  relay_id: string
  retention_days: number | null
  size_limit_bytes: number | string | null
  target_id: string
  target_kind: "database" | "instance" | "platform"
}

interface KeptBackupRow extends RowDataPacket {
  bytes: number | string | null
  created_at: number | string
  id: string
}

interface Retention {
  bytes: number | null
  days: number | null
  quantity: number | null
}

export interface ExpiredBackup {
  backupId: string
  relayId: string
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

/** Backups past their target's retention, oldest first. */
export const expiredBackupsEffect = Effect.fn("backups.expired")(function* (
  now: number
) {
  const database = yield* Database
  const policies = yield* database.queryRows<RetentionPolicyRow>(
    "backup_retention_policies",
    `SELECT relay_id, target_kind, target_id, quantity_limit,
            size_limit_bytes, retention_days, admin_quantity_limit,
            admin_size_limit_bytes, admin_retention_days
       FROM ${databaseTable("backup_policy")}
      WHERE COALESCE(quantity_limit, size_limit_bytes, retention_days,
                     admin_quantity_limit, admin_size_limit_bytes,
                     admin_retention_days) IS NOT NULL`
  )
  const expired: Array<ExpiredBackup & { createdAt: number }> = []
  for (const policy of policies) {
    const retention: Retention = {
      bytes: lower(
        nullableNumber(policy.size_limit_bytes),
        nullableNumber(policy.admin_size_limit_bytes)
      ),
      days: lower(policy.retention_days, policy.admin_retention_days),
      quantity: lower(policy.quantity_limit, policy.admin_quantity_limit),
    }
    const backups = yield* database.queryRows<KeptBackupRow>(
      "backup_retention_backups",
      `SELECT id, created_at, bytes
         FROM ${databaseTable("backup")}
        WHERE relay_id = ? AND target_kind = ? AND target_id = ?
          AND status = 'available' AND reason <> 'final_delete'
        ORDER BY created_at DESC, id DESC`,
      [policy.relay_id, policy.target_kind, policy.target_id]
    )
    for (const backup of expiredBackups(backups, retention, now)) {
      expired.push({
        backupId: backup.id,
        createdAt: Number(backup.created_at),
        relayId: policy.relay_id,
      })
    }
  }
  return expired
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((backup): ExpiredBackup => ({
      backupId: backup.backupId,
      relayId: backup.relayId,
    }))
})

// Newest first: the newest stays, then each is kept while it's within the
// number, young enough, and fits in what's left of the space.
function expiredBackups(
  backups: ReadonlyArray<KeptBackupRow>,
  retention: Retention,
  now: number
): Array<KeptBackupRow> {
  const oldest = retention.days === null ? null : now - retention.days * DAY_MS
  let total = 0
  return backups.filter((backup, index) => {
    total += Number(backup.bytes ?? 0)
    if (index === 0) return false
    return (
      (retention.quantity !== null && index >= retention.quantity) ||
      (oldest !== null && Number(backup.created_at) < oldest) ||
      (retention.bytes !== null && total > retention.bytes)
    )
  })
}

function lower(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}
