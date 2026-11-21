import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * When Hearth must have seen a full backup's bucket copy in the bucket, set
 * by Hearth's own clock when the copy first waits to be seen, so no Relay's
 * clock can stretch or remove the wait. UTC epoch milliseconds, as every
 * Kiln time; null for every other copy.
 */
export const bucketCopyDeadlines: Migration = {
  id: 95,
  name: "bucket_copy_deadlines",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("backup_artifact")
    const found = yield* sql<{ found: number }>`
      SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
        AND column_name = 'seen_by'
    `
    if (found.length === 0) {
      yield* sql.unsafe(
        `ALTER TABLE \`${table}\` ADD COLUMN \`seen_by\` bigint unsigned NULL DEFAULT NULL AFTER \`completed_at\``
      )
    }
    // A full backup's bucket copy already waiting to be seen, its upload
    // done, has an hour from now. One still being uploaded gets its hour
    // when its Relay reports it done.
    yield* sql.unsafe(
      `UPDATE \`${table}\` artifact
         JOIN \`${databaseTableName("backup")}\` backup
           ON backup.id = artifact.backup_id AND backup.backup_mode = 'full'
         JOIN \`${databaseTableName("backup_task")}\` task
           ON task.backup_id = backup.id AND task.task_kind = 'create'
          AND task.status = 'succeeded'
          SET artifact.seen_by = ?
        WHERE artifact.seen_by IS NULL AND artifact.status = 'running'
          AND artifact.storage_id IS NOT NULL
          AND artifact.completed_at IS NULL
          AND artifact.id NOT IN (
            SELECT destination_artifact_id
              FROM \`${databaseTableName("backup_copy_task")}\`)`,
      [Date.now() + 60 * 60_000]
    )
  }),
}
