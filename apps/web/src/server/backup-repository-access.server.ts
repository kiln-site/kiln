import { Effect } from "effect"
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
  object_prefix: string | null
  storage_id: string | null
}

const refused = (reason: string): BackupRepositoryAccessReply => ({
  reason: reason.slice(0, 600),
  status: "refused",
})

/**
 * Answers a Relay whose restic needs a file or a folder of a repository in a
 * bucket (`backup.repository.access`), so no Relay holds a bucket's keys.
 *
 * The rule is one: a Relay reaches only its own repositories. Hearth finds the
 * repository by its ID and the Relay whose connection asks, and knows itself
 * where in which bucket that is. What a Relay does to its own server's backups
 * isn't checked, as it could as well back up something else.
 */
export const backupRepositoryAccessEffect = Effect.fnUntraced(function* (
  relayId: string,
  request: BackupRepositoryAccessRequest
) {
  const database = yield* Database
  const [repository] = yield* database.queryRows<RepositoryRow>(
    "backup_repository_access",
    `SELECT object_prefix, storage_id
       FROM ${databaseTable("backup_repository")}
      WHERE id = ? AND relay_id = ?
      LIMIT 1`,
    [request.repositoryId, relayId]
  )
  if (!repository?.storage_id || !repository.object_prefix) {
    return refused("Hearth has no such backup repository of this Relay's")
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
