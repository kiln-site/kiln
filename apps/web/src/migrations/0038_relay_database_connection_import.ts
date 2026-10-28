import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Relays keep every database connection, Apps' included. Apps' used to live
// in their configs as `databaseIds`; Hearth hands those to each Relay
// (lib/app-database-connections.server.ts) and records here when the Relay
// first acknowledged them, and when every App's config on it had been read
// and cleared. Until a Relay acknowledges, its Apps' configs keep them.
export const relayDatabaseConnectionImport: Migration = {
  id: 38,
  name: "relay_database_connection_import",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("relay_database_connection_import")
    const relay = databaseTableName("relay")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`acknowledged_at\` bigint unsigned NOT NULL,
  \`configs_cleared_at\` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (\`relay_id\`),
  CONSTRAINT \`${table}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relay}\` (\`id\`) ON DELETE CASCADE
)`)
  }),
}
