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

type AccessRow = RowDataPacket & {
  artifact_status: string
  backup_reason: string
  object_key: string | null
  storage_id: string | null
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
 * and the destination can still be used that way. A backup a schedule took
 * was started by the Relay, not Hearth, so it also has to name a schedule
 * Hearth sent that Relay whose step sends backups to that destination.
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
            backup.reason AS backup_reason,
            artifact.status AS artifact_status, artifact.storage_id,
            artifact.object_key
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
  if (!row.storage_id || !row.object_key) {
    return refused("that copy isn't kept in a bucket")
  }
  // A copy that's stored isn't written again, and only a stored one is read.
  const usable =
    request.action === "upload"
      ? row.artifact_status === "queued" || row.artifact_status === "running"
      : request.action === "download"
        ? row.artifact_status === "available"
        : row.artifact_status !== "deleted"
  if (!usable) {
    return refused(`the copy is ${row.artifact_status}`)
  }
  if (request.action === "upload" && row.backup_reason === "scheduled") {
    const admitted = request.schedule
      ? yield* database.queryRows<RowDataPacket>(
          "backup_storage_access_schedule",
          `SELECT 1
             FROM ${databaseTable("schedule")} schedule
             JOIN ${databaseTable("schedule_deployment")} deployment
               ON deployment.schedule_id = schedule.id
              AND deployment.relay_id = ?
             JOIN ${databaseTable("schedule_action")} action
               ON action.schedule_id = schedule.id AND action.id = ?
              AND action.action_type = 'backup'
             JOIN ${databaseTable("backup_storage")} storage
               ON storage.id = ?
            WHERE schedule.id = ? AND schedule.deleted_at IS NULL
              AND JSON_UNQUOTE(
                    JSON_EXTRACT(action.action_config, '$.destination.storageId')
                  ) = storage.id
              AND (storage.owner_user_id IS NULL
                   OR storage.owner_user_id = schedule.created_by)
            LIMIT 1`,
          [
            relayId,
            request.schedule.actionId,
            row.storage_id,
            request.schedule.id,
          ]
        )
      : []
    if (admitted.length === 0) {
      return refused(
        "no schedule Hearth sent this Relay backs up to that destination"
      )
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
