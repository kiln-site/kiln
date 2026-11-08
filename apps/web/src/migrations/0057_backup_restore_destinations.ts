import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A restore can go into a resource other than the one its backup was taken
// of, as when that one is gone, so a restore task records where it goes.
// Null keeps the backup's own target, which every earlier task restored.
export const backupRestoreDestinations: Migration = {
  id: 57,
  name: "backup_restore_destinations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("backup_task")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    if (columns.some(({ columnName }) => columnName === "target_id")) return
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`target_kind\` enum('instance','database','platform','app','volume') DEFAULT NULL,
  ADD COLUMN \`target_id\` varchar(200) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
}
