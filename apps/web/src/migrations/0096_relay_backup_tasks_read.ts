import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * How far Hearth has read a Relay's backup task journal: the Relay's own
 * time (`updatedAt`) of the newest change Hearth has applied, so each pass
 * asks only for what changed since. Null until Hearth has read the journal
 * once. UTC epoch milliseconds, by the Relay's clock.
 */
export const relayBackupTasksRead: Migration = {
  id: 96,
  name: "relay_backup_tasks_read",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("relay")
    const found = yield* sql<{ found: number }>`
      SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
        AND column_name = 'backup_tasks_read_at'
    `
    if (found.length === 0) {
      yield* sql.unsafe(
        `ALTER TABLE \`${table}\` ADD COLUMN \`backup_tasks_read_at\` bigint unsigned NULL DEFAULT NULL`
      )
    }
  }),
}
