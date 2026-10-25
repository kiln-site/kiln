import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Linked backups: a duplicated or moved game server's copy can restore the
// original's full archives. Each gets a backup record of the copy's own that
// shares the original's stored archive, naming the backup and server the
// archive was made as. The archive is deleted only with the last record
// that shares it.
export const linkedBackups: Migration = {
  id: 30,
  name: "linked_backups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const backup = databaseTableName("backup")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${backup}
    `
    if (
      !columns.some(({ columnName }) => columnName === "linked_from_backup_id")
    ) {
      yield* sql.unsafe(`ALTER TABLE \`${backup}\`
  ADD COLUMN \`linked_from_backup_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD COLUMN \`linked_from_target_id\` varchar(120) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD KEY \`${backup}_linked_from_idx\` (\`linked_from_backup_id\`)`)
    }
  }),
}
