import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Anyone can connect Cloudflare, more than once. `domain_integration` rows
// become connections with an owner, a person or the platform (NULL), and
// remember the zones their token reached. Vanity settings move to the owner
// in `domain_owner_settings` ('' is the platform), so one person's
// connections share them. `web_hostname` holds the records Kiln keeps for
// web route hostnames and the URLs it generates for apps.
export const cloudflareConnections: Migration = {
  id: 35,
  name: "cloudflare_connections",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const integration = databaseTableName("domain_integration")
    const settings = databaseTableName("domain_owner_settings")
    const hostname = databaseTableName("web_hostname")
    // DDL is not transactional; each step checks the schema so a retry after
    // a crash picks up where it stopped.
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${integration}
    `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.columnName))))

    if (!columns.has("owner_id")) {
      yield* sql.unsafe(`ALTER TABLE \`${integration}\`
  ADD COLUMN \`owner_id\` varchar(36) DEFAULT NULL AFTER \`provider\`,
  ADD COLUMN \`name\` varchar(64) NOT NULL DEFAULT 'Cloudflare' AFTER \`owner_id\`,
  ADD COLUMN \`zones\` json DEFAULT NULL AFTER \`api_token_ciphertext\`,
  ADD KEY \`${integration}_owner_idx\` (\`owner_id\`)`)
    }

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${settings}\` (
  \`owner_key\` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`auto_assign\` tinyint(1) NOT NULL DEFAULT '1',
  \`assignment_strategy\` enum('default','random','balanced') NOT NULL DEFAULT 'default',
  \`blacklist_patterns\` json NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`owner_key\`)
)`)

    if (columns.has("assignment_strategy")) {
      // The one connection there was is the platform's.
      const now = yield* Clock.currentTimeMillis
      yield* sql`
        INSERT IGNORE INTO ${sql(settings)}
          (owner_key, auto_assign, assignment_strategy, blacklist_patterns,
           created_at, updated_at)
        SELECT '', enabled, assignment_strategy, blacklist_patterns,
               ${now}, ${now}
        FROM ${sql(integration)}
        WHERE owner_id IS NULL
        LIMIT 1
      `
      // Last, so a retry can still copy them above.
      yield* sql.unsafe(`ALTER TABLE \`${integration}\`
  DROP COLUMN \`enabled\`,
  DROP COLUMN \`assignment_strategy\`,
  DROP COLUMN \`blacklist_patterns\``)
    }

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${hostname}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`hostname\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_type\` enum('app','instance') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`integration_id\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`zone_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`vanity_domain\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`is_generated\` tinyint(1) NOT NULL DEFAULT '0',
  \`record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`record_type\` enum('A','AAAA','CNAME') DEFAULT NULL,
  \`target\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`status\` enum('pending','active','external','error','removing') NOT NULL DEFAULT 'pending',
  \`last_error\` varchar(512) DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${hostname}_hostname_unique\` (\`hostname\`),
  KEY \`${hostname}_resource_idx\` (\`relay_id\`,\`resource_type\`,\`resource_id\`),
  KEY \`${hostname}_integration_idx\` (\`integration_id\`)
)`)
  }),
}
