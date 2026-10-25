import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Server migrations: copying a game server to a new one, on the same Relay or
// another, and for a move, handing its place over to the copy. A row holds
// what someone asked for and how far the copy got, so one that stopped, such
// as when Hearth restarted, carries on (lib/server-migrations.server.ts).
// Finished rows stay as the new server's lineage: which server it came from.
export const serverMigrations: Migration = {
  id: 29,
  name: "server_migrations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("server_migration")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`id\` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`requested_by\` varchar(36) NOT NULL,
  \`actor\` json NOT NULL,
  \`mode\` enum('duplicate','migrate') NOT NULL,
  \`source_relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`source_instance_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`source_name\` varchar(64) NOT NULL,
  \`destination_relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`destination_instance_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`destination_name\` varchar(32) NOT NULL,
  \`create_key\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`options\` json NOT NULL,
  \`state\` enum('running','cancelling','completed','failed','cancelled') NOT NULL DEFAULT 'running',
  \`step\` enum('backup','stop','create','provision','copy','finish') NOT NULL,
  \`source_was_running\` tinyint(1) DEFAULT NULL,
  \`destination_created\` tinyint(1) NOT NULL DEFAULT '0',
  \`backup_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`transfer_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`finished_parts\` json DEFAULT NULL,
  \`received_bytes\` bigint unsigned NOT NULL DEFAULT '0',
  \`total_bytes\` bigint unsigned DEFAULT NULL,
  \`error\` varchar(512) DEFAULT NULL,
  \`claim_generation\` int unsigned NOT NULL DEFAULT '0',
  \`lease_until\` bigint unsigned DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  \`finished_at\` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`${table}_requester_idx\` (\`requested_by\`,\`state\`,\`updated_at\`),
  KEY \`${table}_running_idx\` (\`state\`,\`lease_until\`),
  KEY \`${table}_destination_idx\` (\`destination_relay_id\`,\`destination_instance_id\`),
  KEY \`${table}_source_idx\` (\`source_relay_id\`,\`source_instance_id\`)
)`)
  }),
}
