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
  | { relayId: string; target: { id: string; kind: BackupTargetKind } }

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
  // Kiln's own backups are scheduled on its Relay; Apps and volumes
  // aren't schedule targets yet.
  const target =
    scope.target.kind === "platform"
      ? { id: scope.relayId, kind: "relay" }
      : scope.target.kind === "instance" || scope.target.kind === "database"
        ? scope.target
        : null
  if (!target) return
  yield* transaction.execute(
    `UPDATE ${databaseTable("schedule_deployment")} deployment
         JOIN ${databaseTable("schedule_target")} target
           ON target.schedule_id = deployment.schedule_id
          AND target.relay_id = deployment.relay_id
          SET deployment.status = 'pending',
              deployment.desired_generation = deployment.desired_generation + 1,
              deployment.updated_at = ?
        WHERE target.relay_id = ? AND target.target_kind = ?
          AND target.target_id = ?`,
    [now, scope.relayId, target.kind, target.id]
  )
})
