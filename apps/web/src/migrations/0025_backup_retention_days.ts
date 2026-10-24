import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A target's backup policy is its retention: the most backups it keeps, the
// most space they take, and now the longest it keeps them, each with a
// platform administrator's ceiling. Schedules no longer carry retention of
// their own, so it's dropped from their stored actions. Each column is
// skipped once added, so a migration that stopped partway finishes on the
// next start.
export const backupRetentionDays: Migration = {
  id: 25,
  name: "backup_retention_days",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const policy = databaseTableName("backup_policy")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${policy}
    `
    for (const column of ["retention_days", "admin_retention_days"]) {
      if (columns.some(({ columnName }) => columnName === column)) continue
      yield* sql.unsafe(`ALTER TABLE \`${policy}\`
  ADD COLUMN \`${column}\` int unsigned DEFAULT NULL`)
    }
    const action = databaseTableName("schedule_action")
    yield* sql.unsafe(`UPDATE \`${action}\`
  SET action_config = JSON_REMOVE(action_config, '$.retention')
  WHERE action_type = 'backup'
    AND JSON_CONTAINS_PATH(action_config, 'one', '$.retention')`)
  }),
}
