import { Clock, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import type {
  BackupRepositoryAccessReply,
  BackupRepositoryAccessRequest,
} from "@workspace/contracts"

import {
  listS3RepositoryFolder,
  loadBackupStorageCredentialEffect,
  s3Refusal,
  signS3RepositoryFile,
} from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { runAppEffectUntraced } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

type RepositoryRow = RowDataPacket & {
  linked: number
  object_prefix: string | null
  orphaned: number
  relay_id: string
  storage_id: string | null
}

// A delete's prune runs after the delete has ended, and writes as it did.
const deletedReachMs = 24 * 60 * 60 * 1000

const refused = (reason: string): BackupRepositoryAccessReply => ({
  reason: reason.slice(0, 600),
  status: "refused",
})

/**
 * Answers a Relay whose restic needs a file or a folder of a repository in a
 * bucket (`backup.repository.access`), so no Relay holds a bucket's keys.
 *
 * The rule is one: a Relay reaches its own repositories, and reads one a
 * backup was linked to it from, as restoring it there does. With the Relay
 * that made it gone from Hearth, the Relay it's linked to writes to it too, as
 * deleting the backup does: no other is left to. Hearth finds the repository
 * by its ID and the Relay whose connection asks, and knows itself where in
 * which bucket that is. What a Relay does to its own server's backups isn't
 * checked, as it could as well back up something else.
 */
export const backupRepositoryAccessEffect = Effect.fnUntraced(function* (
  relayId: string,
  request: BackupRepositoryAccessRequest
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const [repository] = yield* database.queryRows<RepositoryRow>(
    "backup_repository_access",
    `SELECT repository.object_prefix, repository.storage_id,
            repository.relay_id,
            EXISTS (
              SELECT 1 FROM ${databaseTable("backup")} backup
               WHERE backup.repository_id = repository.id
                 AND backup.relay_id = ?
                 AND backup.linked_from_backup_id IS NOT NULL
                 AND (
                   backup.status IN ('available', 'deleting')
                   OR (backup.status = 'deleted' AND backup.deleted_at > ?)
                 )
            ) AS linked,
            NOT EXISTS (
              SELECT 1 FROM ${databaseTable("relay")} relay
               WHERE relay.id = repository.relay_id
            ) AS orphaned
       FROM ${databaseTable("backup_repository")} repository
      WHERE repository.id = ?
      LIMIT 1`,
    [relayId, now - deletedReachMs, request.repositoryId]
  )
  const own = repository?.relay_id === relayId
  if (
    !repository?.storage_id ||
    !repository.object_prefix ||
    (!own && !repository.linked)
  ) {
    return refused("Hearth has no such backup repository of this Relay's")
  }
  const reads = request.method === "GET" || request.method === "LIST"
  if (!own && !reads && !repository.orphaned) {
    // As a bucket says it, so restic reads without its lock.
    return refused("AccessDenied: another Relay's repository is only read")
  }
  const storage = yield* loadBackupStorageCredentialEffect(
    repository.storage_id
  )
  if (!storage || storage.deleting) {
    return refused("The backup destination is unavailable")
  }
  const repositoryPrefix = repository.object_prefix
  if (request.method !== "LIST") {
    return yield* signS3RepositoryFile(storage, {
      file: request.file,
      method: request.method,
      repositoryPrefix,
    })
  }
  return yield* listS3RepositoryFolder(storage, {
    after: request.after,
    folder: request.folder,
    repositoryPrefix,
  }).pipe(
    // A bucket that refuses is answered, as it would refuse again. Anything
    // else fails the request, which restic tries again.
    Effect.catch((cause) => {
      const said = s3Refusal(cause)
      return said === null ? Effect.fail(cause) : Effect.succeed(refused(said))
    })
  )
})

/** Untraced: restic asks for each file it touches. */
export function answerBackupRepositoryAccess(
  relayId: string,
  request: BackupRepositoryAccessRequest
): Promise<BackupRepositoryAccessReply> {
  return runAppEffectUntraced(backupRepositoryAccessEffect(relayId, request))
}
