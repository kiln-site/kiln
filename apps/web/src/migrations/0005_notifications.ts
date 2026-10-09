import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// One row per recipient. Broadcasts fan out at write time, so reading and
// clearing stay per-user. `source_key` names the event (a release, an
// invitation) so repeated delivery never duplicates a user's row; cleared rows
// stay as `dismissed_at` so a later check can't deliver them again. No foreign
// keys, like `instance_favorite`: development sign-in has no user row.
export const notifications: Migration = {
  id: 5,
  name: "notifications",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("notification")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`user_id\` varchar(36) NOT NULL,
  \`kind\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`source_key\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`data\` json NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`read_at\` bigint unsigned DEFAULT NULL,
  \`dismissed_at\` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${table}_source_unique\` (\`user_id\`,\`source_key\`),
  KEY \`${table}_user_created_idx\` (\`user_id\`,\`created_at\`)
)`)
  }),
}
