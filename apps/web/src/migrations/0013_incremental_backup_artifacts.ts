import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The legacy startup migration copied every backup into an artifact keyed by
// its storage, so incremental backups made before it was removed also carry a
// phantom artifact beside their restic one. A restic delete reports one
// artifact, so deleting such a backup could forget its snapshot and still
// leave it listed as available. Finish those deletes and drop the phantoms.
export const incrementalBackupArtifacts: Migration = {
  id: 13,
  name: "incremental_backup_artifacts",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const backup = databaseTableName("backup")
    const artifact = databaseTableName("backup_artifact")
    const task = databaseTableName("backup_task")
    const now = yield* Clock.currentTimeMillis
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // A succeeded restic delete has already forgotten the snapshot.
        const forgotten = sql`
          SELECT backup_id, MAX(finished_at) AS finished_at
          FROM ${sql(task)}
          WHERE task_kind = 'delete' AND status = 'succeeded'
          GROUP BY backup_id
        `
        yield* sql`
          UPDATE ${sql(artifact)} artifact
          JOIN ${sql(backup)} backup ON backup.id = artifact.backup_id
          JOIN (${forgotten}) forgotten ON forgotten.backup_id = backup.id
          SET artifact.status = 'deleted',
              artifact.deleted_at = COALESCE(forgotten.finished_at, ${now}),
              artifact.updated_at = ${now}
          WHERE backup.backup_mode = 'incremental'
            AND backup.status <> 'deleted'
            AND artifact.status <> 'deleted'
        `
        yield* sql`
          UPDATE ${sql(backup)} backup
          JOIN (${forgotten}) forgotten ON forgotten.backup_id = backup.id
          SET backup.status = 'deleted',
              backup.deleted_at = COALESCE(forgotten.finished_at, ${now}),
              backup.updated_at = ${now}
          WHERE backup.backup_mode = 'incremental'
            AND backup.status <> 'deleted'
        `
        // A create dispatched with the phantom first reported only it, so it
        // may be the one that recorded the snapshot as available.
        yield* sql`
          UPDATE ${sql(artifact)} snapshot
          JOIN ${sql(backup)} backup ON backup.id = snapshot.backup_id
          JOIN ${sql(artifact)} phantom
            ON phantom.backup_id = snapshot.backup_id
           AND phantom.id = phantom.backup_id
           AND phantom.destination_key <> 'restic'
          SET snapshot.status = phantom.status,
              snapshot.bytes = phantom.bytes,
              snapshot.error = NULL,
              snapshot.completed_at = phantom.completed_at,
              snapshot.updated_at = ${now}
          WHERE backup.backup_mode = 'incremental'
            AND snapshot.destination_key = 'restic'
            AND phantom.status = 'available'
            AND snapshot.status IN ('queued', 'running', 'failed')
        `
        yield* sql`
          DELETE phantom
          FROM ${sql(artifact)} phantom
          JOIN ${sql(backup)} backup ON backup.id = phantom.backup_id
          JOIN ${sql(artifact)} snapshot
            ON snapshot.backup_id = phantom.backup_id
           AND snapshot.destination_key = 'restic'
          WHERE backup.backup_mode = 'incremental'
            AND phantom.id = phantom.backup_id
            AND phantom.destination_key <> 'restic'
        `
      })
    )
  }),
}
