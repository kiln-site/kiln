import type { BackupTargetKind } from "@workspace/contracts"
import { Clock, Effect } from "effect"

import type { DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

/**
 * What a change can make Hearth send again: the schedules backing up one
 * target, or every schedule backing up to one destination.
 */
export type ScheduleInvalidationScope =
  | { storageId: string }
  | {
      backupOnly?: boolean
      relayId: string
      // An App is no backup target, and a schedule still names one.
      target: { id: string; kind: BackupTargetKind | "app" }
    }

/**
 * Marks the schedules a change affects as owed to their Relays, in the
 * change's own transaction: whether their backups may run, where to, and
 * with what credentials depends on it (`scheduledBackupAdmissionEffect`).
 * Each gets a newer generation, so whatever was sent before is superseded,
 * and is sent again by `deliverPendingSchedules` or the sweep, however the
 * change's work after its commit goes.
 */
export const invalidateScheduleDeploymentsEffect = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  scope: ScheduleInvalidationScope
) {
  const now = yield* Clock.currentTimeMillis
  if ("storageId" in scope) {
    yield* transaction.execute(
      `UPDATE ${databaseTable("schedule_deployment")} deployment
           JOIN ${databaseTable("schedule_action")} action
             ON action.schedule_id = deployment.schedule_id
            SET deployment.status = 'pending',
                deployment.desired_generation = deployment.desired_generation + 1,
                deployment.updated_at = ?
          WHERE action.action_type = 'backup'
            AND JSON_UNQUOTE(
                  JSON_EXTRACT(action.action_config, '$.destination.storageId')
                ) = ?`,
      [now, scope.storageId]
    )
    return
  }
  // A volume is no App's, and any App on its Relay may be backed up with
  // it: every App's backup schedules there are sent again.
  const target: { id: string | null; kind: string } =
    scope.target.kind === "platform"
      ? { id: scope.relayId, kind: "relay" }
      : scope.target.kind === "volume"
        ? { id: null, kind: "app" }
        : scope.target
  const backupOnly = scope.backupOnly || target.id === null
  yield* transaction.execute(
    `UPDATE ${databaseTable("schedule_deployment")} deployment
         JOIN ${databaseTable("schedule_target")} target
           ON target.schedule_id = deployment.schedule_id
          AND target.relay_id = deployment.relay_id
          SET deployment.status = 'pending',
              deployment.desired_generation = deployment.desired_generation + 1,
              deployment.updated_at = ?
        WHERE target.relay_id = ? AND target.target_kind = ?
          ${target.id === null ? "" : "AND target.target_id = ?"}
          ${
            backupOnly
              ? `AND EXISTS (
            SELECT 1 FROM ${databaseTable("schedule_action")} action
             WHERE action.schedule_id = deployment.schedule_id
               AND action.action_type = 'backup'
          )`
              : ""
          }`,
    [
      now,
      scope.relayId,
      target.kind,
      ...(target.id === null ? [] : [target.id]),
    ]
  )
})
