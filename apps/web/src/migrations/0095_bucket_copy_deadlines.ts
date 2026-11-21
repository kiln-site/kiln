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
  }),
}
