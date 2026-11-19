import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import type {
  BackupStorageAccessAction,
  BackupStorageAccessRequest,
  BackupStorageAccessResponse,
} from "@workspace/contracts"

import {
  loadBackupStorageCredentialEffect,
  signS3BackupAccess,
} from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { holdsScheduleBackup } from "@/server/schedule-acknowledged-backups"

type AccessRow = RowDataPacket & {
  artifact_created_at_ms: number | string
  artifact_status: string
  backup_reason: string
  backup_status: string
  dependency_status: string | null
  depends_on_task_id: string | null
  object_key: string | null
  storage_id: string | null
  target_id: string
  target_kind: string
  task_kind: string
  task_status: string
}

// The kind of task each access belongs to: nothing else may ask for it.
const taskKindFor = {
  delete: "delete",
  download: "restore",
  upload: "create",
} as const satisfies Record<BackupStorageAccessAction, string>

function refused(reason: string): BackupStorageAccessResponse {
  return { reason, status: "refused" }
}

/**
 * Answers a Relay that asked for access to one copy of a backup in a bucket
 * (`backup.storage.access`), with one signed request for that object or a
 * refusal.
 *
 * Hearth holds every bucket's keys and paths, so this is the only way a
 * Relay reaches one, and what it checks is all that stands between a Relay
 * and another's backups: the task is that Relay's and still under way, the
 * copy belongs to the task's backup, the access is the kind the task needs,
 * and the destination can still be used that way. A task Hearth started is
 * held to what Hearth would send it for: a restore reads only the copy
 * Hearth would name, a local one first, and nothing runs ahead of the task
 * it waits on.
 *
 * A backup a schedule took was started by the Relay, not Hearth, so its
 * upload also needs a schedule the Relay acknowledged holding whose backups
 * of that target go to that destination (`acknowledged_backups`). While
 * Hearth still owes that Relay a schedule the answer is "later": the one
 * that allows it may be on its way.
 *
 * `catalogRelayTasks` reads in the Relay's tasks: a scheduled backup taken
 * while Hearth was away asks for access before Hearth has heard of it.
 */
export const grantBackupStorageAccessEffect = Effect.fn(
  "backups.storageAccess"
)(function* (
  relayId: string,
  request: BackupStorageAccessRequest,
  catalogRelayTasks: Effect.Effect<void, unknown>
) {
  yield* Effect.annotateCurrentSpan({
    "backup.id": request.backupId,
    "backup.storage.action": request.action,
    "backup.task.id": request.taskId,
    "relay.id": relayId,
  })
  const database = yield* Database
  const find = database.queryRows<AccessRow>(
    "backup_storage_access",
    `SELECT task.task_kind, task.status AS task_status,
            task.depends_on_task_id,
            (SELECT dependency.status
               FROM ${databaseTable("backup_task")} dependency
              WHERE dependency.id = task.depends_on_task_id
            ) AS dependency_status,
            backup.reason AS backup_reason, backup.status AS backup_status,
            backup.target_kind, backup.target_id,
            artifact.status AS artifact_status, artifact.storage_id,
            artifact.object_key,
            artifact.created_at AS artifact_created_at_ms
       FROM ${databaseTable("backup_task")} task
       JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
       JOIN ${databaseTable("backup_artifact")} artifact
         ON artifact.backup_id = backup.id
      WHERE task.id = ? AND backup.id = ? AND backup.relay_id = ?
        AND artifact.id = ?
      LIMIT 1`,
    [request.taskId, request.backupId, relayId, request.artifactId]
  )
  let row = (yield* find)[0]
  if (!row && request.action === "upload") {
    yield* catalogRelayTasks
    row = (yield* find)[0]
  }
  if (!row) return refused("Hearth knows no such task of this Relay's")
  if (row.task_kind !== taskKindFor[request.action]) {
    return refused(`a ${row.task_kind} task can't ${request.action} a copy`)
  }
  if (row.task_status !== "queued" && row.task_status !== "running") {
    return refused("the task has ended")
  }
  // As Hearth sends them (`listDispatchableBackupTasksEffect`): a restore
  // follows its safety backup only once that succeeded, and a delete
  // follows the create it waits on however that ended.
  if (
    row.depends_on_task_id !== null &&
    row.dependency_status !== "succeeded" &&
    !(
      request.action === "delete" &&
      (row.dependency_status === "failed" ||
        row.dependency_status === "cancelled")
    )
  ) {
    return refused("the task it waits on hasn't ended")
  }
  if (!row.storage_id || !row.object_key) {
    return refused("that copy isn't kept in a bucket")
  }
  // A copy that's stored isn't written again, and only a stored one is read.
  const usable =
    request.action === "upload"
      ? row.artifact_status === "queued" || row.artifact_status === "running"
      : request.action === "download"
        ? row.artifact_status === "available" &&
          row.backup_status === "available"
        : row.artifact_status !== "deleted" && row.backup_status === "deleting"
  if (!usable) {
    return refused(`the copy is ${row.artifact_status}`)
  }
  if (request.action === "download") {
    // A restore reads the copy Hearth names for it: the Relay's own when it
    // has one, or else the first stored.
    const preferred = yield* database.queryRows<RowDataPacket>(
      "backup_storage_access_restore_copy",
      `SELECT 1
         FROM ${databaseTable("backup_artifact")} other
        WHERE other.backup_id = ? AND other.id <> ?
          AND other.status = 'available'
          AND (other.storage_id IS NULL OR other.created_at < ?)
        LIMIT 1`,
      [request.backupId, request.artifactId, row.artifact_created_at_ms]
    )
    if (preferred.length > 0) {
      return refused("the restore reads another copy of the backup")
    }
  }
  const storage = yield* loadBackupStorageCredentialEffect(row.storage_id)
  // As a task Hearth sends is held to: a new backup needs a destination
  // that's enabled, and one being deleted only gives up what a restore
  // reads. Its purge removes what it holds.
  if (
    !storage ||
    (request.action === "upload" && !storage.enabled) ||
    (request.action !== "download" && storage.deleting)
  ) {
    return refused("the backup destination is unavailable")
  }
  if (request.action === "upload" && row.backup_reason === "scheduled") {
    const deployments = yield* database.queryRows<
      RowDataPacket & { acknowledged_backups: unknown; owed: number }
    >(
      "backup_storage_access_schedules",
      `SELECT deployment.acknowledged_backups,
              (deployment.status <> 'applied'
                OR COALESCE(deployment.acknowledged_revision, 0)
                     < deployment.desired_revision
                OR COALESCE(deployment.acknowledged_generation, 0)
                     < deployment.desired_generation
                OR deployment.acknowledged_backups IS NULL) AS owed
         FROM ${databaseTable("schedule_deployment")} deployment
         JOIN ${databaseTable("schedule")} schedule
           ON schedule.id = deployment.schedule_id
        WHERE deployment.relay_id = ? AND schedule.deleted_at IS NULL`,
      [relayId]
    )
    const held = deployments.some((deployment) =>
      holdsScheduleBackup(deployment.acknowledged_backups, {
        storageId: storage.id,
        targetId: row.target_id,
        targetKind: row.target_kind,
      })
    )
    if (!held) {
      const reason =
        "no schedule this Relay holds backs that up to that destination"
      return deployments.some((deployment) => Number(deployment.owed) === 1)
        ? ({ reason, status: "later" } satisfies BackupStorageAccessResponse)
        : refused(reason)
    }
  }
  return yield* signS3BackupAccess(storage, row.object_key, request.action)
})

/** Answers `backup.storage.access` for the Relay a control connection is. */
export function answerBackupStorageAccess(
  relayId: string,
  request: BackupStorageAccessRequest
): Promise<BackupStorageAccessResponse> {
  return runAppEffect(
    "Backups.storageAccess",
    grantBackupStorageAccessEffect(
      relayId,
      request,
      promiseEffect(async () => {
        const { reconcileBackupsAfterRelayConnect } =
          await import("@/lib/backup-reconciliation")
        await reconcileBackupsAfterRelayConnect(relayId)
      })
    )
  )
}
