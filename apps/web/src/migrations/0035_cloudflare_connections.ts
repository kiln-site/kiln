import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Anyone can connect Cloudflare, more than once. `domain_integration` rows
// become connections with an owner, a person or the platform (NULL, shared
// with everyone), and remember the zones their token reached. Addresses
// always go under the owner's default vanity domain, so the assignment
// strategy and on/off switch go; the switch, if off, leaves the connection's
// domains unmarked instead. `blacklist_patterns` stays, as a shared
// connection's reserved names. `web_hostname` holds the records Kiln keeps
// for web route hostnames and the URLs it generates for apps.
// `hostname_claim` gives every hostname Kiln keeps one game server or app,
// whichever table uses it; existing game server domains claim theirs. A game
// server domain being renamed holds its old and new names until Cloudflare
// has the new one, and unfinished DNS work waits for its next attempt.
export const cloudflareConnections: Migration = {
  id: 35,
  name: "cloudflare_connections",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const integration = databaseTableName("domain_integration")
    const zone = databaseTableName("domain_zone")
    const hostname = databaseTableName("web_hostname")
    const claim = databaseTableName("hostname_claim")
    const assignment = databaseTableName("instance_domain")
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

    if (columns.has("enabled")) {
      // With automatic addresses off, its domains took no new ones.
      yield* sql`
        UPDATE ${sql(zone)} zone
          JOIN ${sql(integration)} connection
            ON connection.id = zone.integration_id
           SET zone.enabled = 0
         WHERE connection.enabled = 0
      `
    }
    const dropped = ["enabled", "assignment_strategy"].filter((column) =>
      columns.has(column)
    )
    if (dropped.length > 0) {
      // Last, so a retry can still read the switch above.
      yield* sql.unsafe(`ALTER TABLE \`${integration}\`
  ${dropped.map((column) => `DROP COLUMN \`${column}\``).join(",\n  ")}`)
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
  \`routed\` tinyint(1) NOT NULL DEFAULT '0',
  \`record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`record_type\` enum('A','AAAA','CNAME') DEFAULT NULL,
  \`target\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`status\` enum('pending','active','external','error','removing') NOT NULL DEFAULT 'pending',
  \`last_error\` varchar(512) DEFAULT NULL,
  \`attempts\` smallint unsigned NOT NULL DEFAULT '0',
  \`next_attempt_at\` bigint unsigned DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${hostname}_hostname_unique\` (\`hostname\`),
  KEY \`${hostname}_resource_idx\` (\`relay_id\`,\`resource_type\`,\`resource_id\`),
  KEY \`${hostname}_integration_idx\` (\`integration_id\`)
)`)

    const assignmentColumns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${assignment}
    `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.columnName))))
    if (!assignmentColumns.has("next_vanity_label")) {
      yield* sql.unsafe(`ALTER TABLE \`${assignment}\`
  ADD COLUMN \`next_vanity_label\` varchar(63) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`domain\`,
  ADD COLUMN \`next_domain\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER \`next_vanity_label\`,
  ADD COLUMN \`attempts\` smallint unsigned NOT NULL DEFAULT '0' AFTER \`last_error\`,
  ADD COLUMN \`next_attempt_at\` bigint unsigned DEFAULT NULL AFTER \`attempts\``)
    }

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${claim}\` (
  \`hostname\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_type\` enum('app','instance') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`hostname\`),
  KEY \`${claim}_resource_idx\` (\`relay_id\`,\`resource_type\`,\`resource_id\`)
)`)
    // Hostnames are kept lowercase, so one key covers every spelling.
    yield* sql.unsafe(`INSERT IGNORE INTO \`${claim}\`
  (hostname, relay_id, resource_type, resource_id, created_at)
SELECT LOWER(CONCAT(vanity_label, '.', domain)), relay_id, 'instance',
       instance_id, created_at
  FROM \`${assignment}\``)
  }),
}
