import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What a Relay holds of a schedule's backups to buckets: the destinations
// and targets of the version it last acknowledged. Hearth signs a
// scheduled backup's upload only for one of them
// (`grantBackupStorageAccessEffect`). Null until the Relay acknowledges a
// send, which the sweep makes for every schedule already delivered.
export const scheduleAcknowledgedBackups: Migration = {
  id: 92,
  name: "schedule_acknowledged_backups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const deployment = databaseTableName("schedule_deployment")
    const [column] = yield* sql<{ present: number }>`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${deployment}
        AND column_name = 'acknowledged_backups'
    `
    if (column) return
    yield* sql.unsafe(
      `ALTER TABLE \`${deployment}\` ADD COLUMN \`acknowledged_backups\` json DEFAULT NULL AFTER \`acknowledged_generation\``
    )
  }),
}
