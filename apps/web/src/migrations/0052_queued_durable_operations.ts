import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A durable operation can be recorded before its turn, waiting, so one
// queued survives a restart and starts once it has its locks. An image
// update's claim on a digest notes the deployment that made it, so that
// deployment run again knows the claim as its own.
export const queuedDurableOperations: Migration = {
  id: 52,
  name: "queued_durable_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const attempt = databaseTableName("app_image_update_attempt")
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  MODIFY \`state\` enum('waiting','running','succeeded','failed','cancelled','interrupted') NOT NULL`)
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${attempt}
         AND column_name = 'deployment_id'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${attempt}\`
  ADD COLUMN \`deployment_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`)
  }),
}
