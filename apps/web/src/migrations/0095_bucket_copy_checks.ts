import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * What Hearth knows of looking for a full backup's bucket copy in the
 * bucket, kept with the copy so a restart forgets none of it:
 *
 * - `seen_by`: when Hearth must have seen it, set by Hearth's own clock when
 *   the copy first waits, so no Relay's clock can stretch or remove the wait.
 * - `report_generation`: advanced each time a report changes the size its
 *   Relay says it uploaded. A look settles, or leaves word on, only the
 *   report it looked for.
 * - `check_after` and `check_rests`: when Hearth may ask the bucket for it
 *   again, after a refusal, and how many times it has been left alone, so
 *   each wait is longer.
 * - `check_note`: what the last look that didn't settle it heard, said
 *   when the copy fails at its deadline. Set, it has been looked for.
 *
 * Times are UTC epoch milliseconds, as every Kiln time.
 */
export const bucketCopyChecks: Migration = {
  id: 95,
  name: "bucket_copy_checks",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("backup_artifact")
    const columns = [
      ["seen_by", "bigint unsigned NULL DEFAULT NULL", "completed_at"],
      ["report_generation", "int unsigned NOT NULL DEFAULT 0", "seen_by"],
      ["check_after", "bigint unsigned NULL DEFAULT NULL", "report_generation"],
      ["check_rests", "tinyint unsigned NOT NULL DEFAULT 0", "check_after"],
      ["check_note", "varchar(512) NULL DEFAULT NULL", "check_rests"],
    ] as const
    for (const [name, type, after] of columns) {
      const found = yield* sql<{ found: number }>`
        SELECT 1 AS found FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ${table}
          AND column_name = ${name}
      `
      if (found.length === 0) {
        yield* sql.unsafe(
          `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type} AFTER \`${after}\``
        )
      }
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
