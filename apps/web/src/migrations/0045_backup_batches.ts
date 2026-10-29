import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Backing up an App backs up its folder and each volume its Compose project
// owns, each a backup of its own, started together: they share a batch, so
// the App's page can say whether all of them succeeded.
export const backupBatches: Migration = {
  id: 45,
  name: "backup_batches",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const backup = databaseTableName("backup")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${backup}
    `
    if (columns.some(({ columnName }) => columnName === "batch_id")) return
    yield* sql.unsafe(`ALTER TABLE \`${backup}\`
  ADD COLUMN \`batch_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD KEY \`${backup}_batch_idx\` (\`relay_id\`,\`batch_id\`)`)
  }),
}
