import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// One row per instance a user starred. Like `setting`, rows have no foreign
// keys: Relay snapshots rewrite instance rows, development sign-in has no
// user row, and Kiln disables users instead of deleting them.
export const instanceFavorites: Migration = {
  id: 4,
  name: "instance_favorites",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance_favorite")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`user_id\` varchar(36) NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_kind\` enum('server','database','relay') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`user_id\`,\`relay_id\`,\`resource_kind\`,\`resource_id\`)
)`)
  }),
}
