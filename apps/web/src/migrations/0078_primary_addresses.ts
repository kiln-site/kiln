import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Each instance has one primary address, kept in one row that names it: a
// game server's join address, or one of an App's web routes. A game
// server's join addresses each said whether they were it; that moves into
// the row. Which web route an App's was, its Relay hands over when it next
// connects.
export const primaryAddresses: Migration = {
  id: 78,
  name: "primary_addresses",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const primary = databaseTableName("instance_primary_address")
    const address = databaseTableName("instance_address")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${primary}\` (
  \`instance_type\` enum('app','database','instance') NOT NULL,
  \`instance_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`address_kind\` enum('join','route') NOT NULL,
  \`address_ref\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`chosen_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`instance_type\`,\`instance_id\`)
)`)
    const [marked] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${address}
         AND column_name = 'is_primary'
    `
    if (Number(marked?.count ?? 0) === 0) return
    // The oldest, should a game server somehow have had two.
    yield* sql.unsafe(`INSERT IGNORE INTO \`${primary}\`
        (instance_type, instance_id, address_kind, address_ref, chosen_at)
      SELECT resource_type, resource_id, 'join', id, updated_at
        FROM \`${address}\`
       WHERE is_primary = 1 AND game = 1 AND resource_type = 'instance'
       ORDER BY created_at, id`)
    yield* sql.unsafe(`ALTER TABLE \`${address}\` DROP COLUMN is_primary`)
  }),
}
