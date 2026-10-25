import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Kiln itself can be favorited, and platform administrators start with it
// starred so it leads their instance picker. Administrators who already exist
// get the star here; new ones get it when they become administrators.
export const kilnFavorite: Migration = {
  id: 28,
  name: "kiln_favorite",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const favorites = databaseTableName("instance_favorite")
    yield* sql.unsafe(`ALTER TABLE \`${favorites}\`
  MODIFY \`resource_kind\` enum('server','database','relay','app','kiln') NOT NULL`)
    const now = yield* Clock.currentTimeMillis
    yield* sql`
      INSERT INTO ${sql(favorites)}
        (user_id, relay_id, resource_kind, resource_id, created_at)
      SELECT id, 'kiln', 'kiln', 'kiln', ${now}
        FROM ${sql(databaseTableName("user"))}
       WHERE role = 'admin'
      ON DUPLICATE KEY UPDATE created_at = created_at
    `
  }),
}
