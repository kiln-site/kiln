import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A durable operation can be recorded before its turn, waiting, so one
// queued survives a restart and starts once it has its locks. While it
// waits, a key can name it (`queue_key`), one per kind, so what's asked
// meanwhile joins it rather than queueing another; it gives the key up as
// it starts.
export const queuedDurableOperations: Migration = {
  id: 50,
  name: "queued_durable_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  MODIFY \`state\` enum('waiting','running','succeeded','failed','cancelled','interrupted') NOT NULL`)
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${operation}
         AND column_name = 'queue_key'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  ADD COLUMN \`queue_key\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  ADD UNIQUE KEY \`${operation}_queue_unique\` (\`kind\`,\`queue_key\`)`)
  }),
}
