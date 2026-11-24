import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import {
  forgetNotificationsEffect,
  notifyUsersEffect,
  platformAdminIdsEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { databaseTable } from "@/lib/database-config"
import { kilnBackupOverdueMs } from "@/lib/recovery-code"

/**
 * The newest platform backup the recovery code alone restores Kiln from that
 * has a copy on a backup destination, rather than only on this machine's disk.
 */
export const newestCompleteKilnBackup = Effect.fnUntraced(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    // Kiln's connection reads timestamps as epoch milliseconds.
    RowDataPacket & { completedAt: number | string | null }
  >(
    "kilnBackups.newestComplete",
    `SELECT backup.completed_at AS completedAt
       FROM ${databaseTable("backup")} backup
      WHERE backup.target_kind = 'platform'
        AND backup.status = 'available'
        AND backup.recoverable = 1
        AND EXISTS (
          SELECT 1 FROM ${databaseTable("backup_artifact")} artifact
           WHERE artifact.backup_id = backup.id
             AND artifact.status = 'available'
             AND artifact.storage_id IS NOT NULL
        )
      ORDER BY backup.completed_at DESC
      LIMIT 1`
  )
  return row?.completedAt == null ? null : { at: Number(row.completedAt) }
})

const overdueSourceKey = "kiln.backup-overdue"

/**
 * Tells platform administrators once Kiln hasn't been backed up off its
 * machine for a while, whatever the reason: no schedule, a bucket that's
 * full, a Relay that's away. It goes away once there's one again.
 */
export const warnOfOverdueKilnBackups = Effect.fn("kilnBackups.warnOverdue")(
  function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const [first] = yield* database.queryRows<
      RowDataPacket & { createdAt: number | string | null }
    >(
      "kilnBackups.kilnAge",
      `SELECT MIN(createdAt) AS createdAt FROM ${databaseTable("user")}`
    )
    // A new Kiln has that long to make its first.
    if (
      first?.createdAt == null ||
      now - Number(first.createdAt) < kilnBackupOverdueMs
    ) {
      return
    }
    const newest = yield* newestCompleteKilnBackup()
    if (newest && now - newest.at < kilnBackupOverdueMs) {
      const cleared = yield* forgetNotificationsEffect("kiln.backup-overdue", [
        overdueSourceKey,
      ])
      if (cleared.length) publishNotificationChange(cleared)
      return
    }
    const admins = yield* platformAdminIdsEffect()
    const told = yield* notifyUsersEffect(admins, overdueSourceKey, {
      kind: "kiln.backup-overdue",
      lastAt: newest?.at ?? null,
    })
    if (told) publishNotificationChange(admins)
  }
)
