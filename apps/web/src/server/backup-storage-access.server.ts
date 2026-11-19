import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import type {
  BackupStorageAccessRequest,
  BackupStorageAccessResponse,
} from "@workspace/contracts"

import {
  loadBackupStorageCredentialEffect,
  signS3BackupAccess,
} from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

type CopyRow = RowDataPacket & {
  artifact_status: string
  backup_status: string
  object_key: string | null
  open_restores: number | string
  storage_id: string | null
}

function refused(reason: string): BackupStorageAccessResponse {
  return { reason, status: "refused" }
}

/**
 * Answers a Relay that asked for access to one copy of a backup in a bucket
 * (`backup.storage.access`), with one signed request for that object or a
 * refusal.
 *
 * Hearth holds every bucket's keys and paths, so this is the only way a
 * Relay reaches one. The rule is about the copy, not about the task that
 * wants it, which Hearth decided when it sent the task:
 *
 * - the copy is of a backup on the Relay that asks;
 * - it is written only while it has yet to be stored;
 * - it is read only once stored, and while a restore of its backup is
 *   under way, so a Relay can't read back backups it no longer holds
 *   whenever it likes;
 * - it is deleted only while Hearth is deleting its backup;
 * - its destination can still be used that way.
 */
export const grantBackupStorageAccessEffect = Effect.fn(
  "backups.storageAccess"
)(function* (relayId: string, request: BackupStorageAccessRequest) {
  yield* Effect.annotateCurrentSpan({
    "backup.artifact.id": request.artifactId,
    "backup.storage.action": request.action,
    "relay.id": relayId,
  })
  const database = yield* Database
  const [copy] = yield* database.queryRows<CopyRow>(
    "backup_storage_access",
    `SELECT artifact.status AS artifact_status, artifact.storage_id,
            artifact.object_key, backup.status AS backup_status,
            (SELECT COUNT(*)
               FROM ${databaseTable("backup_task")} restore
              WHERE restore.backup_id = backup.id
                AND restore.task_kind = 'restore'
                AND restore.status IN ('queued', 'running')
            ) AS open_restores
       FROM ${databaseTable("backup_artifact")} artifact
       JOIN ${databaseTable("backup")} backup ON backup.id = artifact.backup_id
      WHERE artifact.id = ? AND backup.relay_id = ?
      LIMIT 1`,
    [request.artifactId, relayId]
  )
  if (!copy) return refused("Hearth knows no such copy of this Relay's")
  if (!copy.storage_id || !copy.object_key) {
    return refused("that copy isn't kept in a bucket")
  }
  if (request.action === "upload") {
    if (
      copy.artifact_status !== "queued" &&
      copy.artifact_status !== "running"
    ) {
      return refused(`the copy is ${copy.artifact_status}`)
    }
  } else if (request.action === "download") {
    if (copy.artifact_status !== "available") {
      return refused(`the copy is ${copy.artifact_status}`)
    }
    if (Number(copy.open_restores) === 0) {
      return refused("no restore of that backup is under way")
    }
  } else if (
    copy.backup_status !== "deleting" ||
    copy.artifact_status === "deleted"
  ) {
    return refused("that backup isn't being deleted")
  }
  const storage = yield* loadBackupStorageCredentialEffect(copy.storage_id)
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
  return yield* signS3BackupAccess(storage, copy.object_key, request.action)
})

/** Answers `backup.storage.access` for the Relay a control connection is. */
export function answerBackupStorageAccess(
  relayId: string,
  request: BackupStorageAccessRequest
): Promise<BackupStorageAccessResponse> {
  return runAppEffect(
    "Backups.storageAccess",
    grantBackupStorageAccessEffect(relayId, request)
  )
}
