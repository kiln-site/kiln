import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// One row per app, and apps can be favorited. Its configuration (source, environment, ports, and
// databases) is one encrypted JSON document, since environments carry
// secrets; the Relay reports the containers it deployed.
export const apps: Migration = {
  id: 7,
  name: "apps",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("app")
    const relayTable = databaseTableName("relay")
    const favoriteTable = databaseTableName("instance_favorite")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`name\` varchar(120) NOT NULL,
  \`config_ciphertext\` mediumtext NOT NULL,
  \`created_by\` varchar(36) NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`app_id\`),
  UNIQUE KEY \`${table}_relay_name_unique\` (\`relay_id\`,\`name\`),
  CONSTRAINT \`${table}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relayTable}\` (\`id\`) ON DELETE CASCADE
)`)
    yield* sql.unsafe(`ALTER TABLE \`${favoriteTable}\`
  MODIFY \`resource_kind\` enum('server','database','relay','app') NOT NULL`)
  }),
}
