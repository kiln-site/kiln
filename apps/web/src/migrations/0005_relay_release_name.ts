import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Relays report a display name from their release labels. Keep the last one so
// offline Relays still show it.
export const relayReleaseName: Migration = {
  id: 5,
  name: "relay_release_name",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("relay")
    // DDL commits on its own, so a retried migration may find the column.
    const existing = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND LOWER(table_name) = LOWER(${table})
        AND column_name = 'node_release_name'
    `
    if (existing.length > 0) return
    yield* sql.unsafe(
      `ALTER TABLE \`${table}\` ADD COLUMN \`node_release_name\` varchar(120) DEFAULT NULL AFTER \`node_version\``
    )
  }),
}
