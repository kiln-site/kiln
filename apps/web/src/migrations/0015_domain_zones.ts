import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// One Cloudflare token can manage several domains, and a game server can have
// several of them. Domains move from the integration row to `domain_zone`, the
// integration gains the strategy that picks a domain for new game servers, and
// `instance_domain` rows get their own ID with one primary row per game server.
export const domainZones: Migration = {
  id: 15,
  name: "domain_zones",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const integration = databaseTableName("domain_integration")
    const zone = databaseTableName("domain_zone")
    const assignment = databaseTableName("instance_domain")
    // DDL is not transactional; each step checks the schema so a retry after
    // a crash picks up where it stopped.
    const columns = (table: string) =>
      sql<{ columnName: string }>`
        SELECT column_name AS columnName
        FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ${table}
      `.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.columnName)))
      )

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${zone}\` (
  \`domain\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`integration_id\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`zone_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`zone_name\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`is_default\` tinyint(1) NOT NULL DEFAULT '0',
  \`enabled\` tinyint(1) NOT NULL DEFAULT '1',
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`domain\`)
)`)

    const integrationColumns = yield* columns(integration)
    if (integrationColumns.has("domain")) {
      const now = yield* Clock.currentTimeMillis
      yield* sql`
        INSERT IGNORE INTO ${sql(zone)}
          (domain, integration_id, zone_id, zone_name, is_default,
           created_at, updated_at)
        SELECT domain, id, zone_id, zone_name, 1, ${now}, ${now}
        FROM ${sql(integration)}
      `
    }
    if (!integrationColumns.has("assignment_strategy")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${integration}\` ADD COLUMN \`assignment_strategy\` enum('default','random','balanced') NOT NULL DEFAULT 'default'`
      )
    }

    const assignmentColumns = yield* columns(assignment)
    if (!assignmentColumns.has("id")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${assignment}\` ADD COLUMN \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL FIRST`
      )
    }
    if (!assignmentColumns.has("is_primary")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${assignment}\` ADD COLUMN \`is_primary\` tinyint(1) NOT NULL DEFAULT '0' AFTER \`instance_id\``
      )
    }
    const primaryKey = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE()
        AND table_name = ${assignment}
        AND constraint_name = 'PRIMARY'
    `
    if (!primaryKey.some((column) => column.columnName === "id")) {
      // Keyed by game server until now, so each row is its server's only
      // domain and becomes its primary.
      yield* sql`
        UPDATE ${sql(assignment)}
        SET id = COALESCE(id, UUID()), is_primary = 1
      `
      yield* sql.unsafe(`ALTER TABLE \`${assignment}\`
  MODIFY \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (\`id\`),
  ADD KEY \`${assignment}_instance_idx\` (\`relay_id\`,\`instance_id\`)`)
    }

    // A domain being deleted keeps its row until Cloudflare confirms, so a
    // Sync doesn't recreate it.
    const [status] = yield* sql<{ columnType: string }>`
      SELECT column_type AS columnType
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${assignment}
        AND column_name = 'status'
    `
    if (status && !status.columnType.includes("'removing'")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${assignment}\` MODIFY \`status\` enum('pending','active','error','removing') NOT NULL DEFAULT 'pending'`
      )
    }

    // Last, so a retry can still copy the domain above.
    if (integrationColumns.has("domain")) {
      yield* sql.unsafe(`ALTER TABLE \`${integration}\`
  DROP COLUMN \`domain\`,
  DROP COLUMN \`zone_id\`,
  DROP COLUMN \`zone_name\``)
    }
  }),
}
