import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// GitHub Apps that people connect to Kiln, and the syncs that copy files
// from one of their repositories into a game server, an app, or a Relay's
// host. A connection belongs to the person who created it; a sync to the
// instance it writes to.
export const githubSync: Migration = {
  id: 16,
  name: "github_sync",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const connection = databaseTableName("github_connection")
    const sync = databaseTableName("github_sync")
    const run = databaseTableName("github_sync_run")
    const relayTable = databaseTableName("relay")

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${connection}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`owner_user_id\` varchar(36) NOT NULL,
  \`app_id\` bigint unsigned NOT NULL,
  \`app_slug\` varchar(100) NOT NULL,
  \`app_name\` varchar(100) NOT NULL,
  \`app_url\` varchar(255) NOT NULL,
  \`app_owner_login\` varchar(100) NOT NULL,
  \`client_id\` varchar(100) NOT NULL,
  \`credentials_ciphertext\` text NOT NULL,
  \`webhook_active\` tinyint(1) NOT NULL DEFAULT '0',
  \`installation_id\` bigint unsigned DEFAULT NULL,
  \`account_login\` varchar(100) DEFAULT NULL,
  \`account_type\` enum('User','Organization') DEFAULT NULL,
  \`account_avatar_url\` varchar(255) DEFAULT NULL,
  \`repository_selection\` enum('all','selected') DEFAULT NULL,
  \`suspended\` tinyint(1) NOT NULL DEFAULT '0',
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${connection}_app_unique\` (\`app_id\`),
  KEY \`${connection}_owner_idx\` (\`owner_user_id\`),
  KEY \`${connection}_installation_idx\` (\`installation_id\`)
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${sync}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`connection_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_kind\` enum('instance','app','relay') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`repository_id\` bigint unsigned NOT NULL,
  \`repository\` varchar(140) NOT NULL,
  \`branch\` varchar(255) NOT NULL,
  \`source_path\` varchar(1024) NOT NULL DEFAULT '',
  \`target_path\` varchar(1024) NOT NULL DEFAULT '',
  \`include_patterns\` json NOT NULL,
  \`auto_sync\` tinyint(1) NOT NULL DEFAULT '1',
  \`overwrite\` tinyint(1) NOT NULL DEFAULT '0',
  \`status\` enum('idle','queued','running','success','error') NOT NULL DEFAULT 'idle',
  \`last_error\` varchar(1024) DEFAULT NULL,
  \`last_commit_sha\` char(40) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`last_commit_message\` varchar(255) DEFAULT NULL,
  \`last_synced_at\` bigint unsigned DEFAULT NULL,
  \`last_changed_count\` int unsigned NOT NULL DEFAULT '0',
  \`synced_files\` json NOT NULL,
  \`created_by\` varchar(36) NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`${sync}_repository_idx\` (\`repository_id\`,\`branch\`),
  KEY \`${sync}_resource_idx\` (\`relay_id\`,\`resource_kind\`,\`resource_id\`),
  KEY \`${sync}_connection_idx\` (\`connection_id\`),
  CONSTRAINT \`${sync}_connection_fk\` FOREIGN KEY (\`connection_id\`) REFERENCES \`${connection}\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`${sync}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relayTable}\` (\`id\`) ON DELETE CASCADE
)`)

    // Finished runs, for Automations → History. Polls that find no new
    // commit aren't runs; each sync keeps its latest 50.
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${run}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`sync_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`trigger\` enum('created','manual','poll','push') NOT NULL,
  \`status\` enum('success','error') NOT NULL,
  \`message\` varchar(1024) DEFAULT NULL,
  \`commit_sha\` char(40) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`commit_message\` varchar(255) DEFAULT NULL,
  \`changed_count\` int unsigned NOT NULL DEFAULT '0',
  \`started_at\` bigint unsigned NOT NULL,
  \`finished_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`${run}_sync_idx\` (\`sync_id\`,\`started_at\`),
  CONSTRAINT \`${run}_sync_fk\` FOREIGN KEY (\`sync_id\`) REFERENCES \`${sync}\` (\`id\`) ON DELETE CASCADE
)`)
  }),
}
