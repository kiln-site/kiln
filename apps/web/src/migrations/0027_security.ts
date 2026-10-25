import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What runs on each Relay's host and what's known to be wrong with it.
//
// - `security_target`: each thing the Relay last reported running (its host,
//   Kiln's own services, and each game server, database, and app service)
//   and the inventory that describes it.
// - `security_sbom`: the Relay's inventory of its host or of one image, a
//   gzipped Syft JSON document, kept per Relay because Hearth can't check
//   what a Relay says an image holds. Images never change, so each is
//   inventoried once; the host's is collected again now and then.
// - `security_finding`: the vulnerabilities Grype found in an inventory
//   against the vulnerability data it last checked it with.
// - `security_vulnerability`: what Grype's data says about each one, shared,
//   since it comes from Grype rather than any Relay.
// - `security_alert`: which of a target's vulnerabilities its people have
//   heard about, so each is announced once while it stays.
export const security: Migration = {
  id: 27,
  name: "security",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const relay = databaseTableName("relay")
    const target = databaseTableName("security_target")
    const sbom = databaseTableName("security_sbom")
    const finding = databaseTableName("security_finding")
    const vulnerability = databaseTableName("security_vulnerability")
    const alert = databaseTableName("security_alert")

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${sbom}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`sbom_key\` varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`image\` varchar(512) DEFAULT NULL,
  \`generator\` varchar(64) DEFAULT NULL,
  \`document\` mediumblob DEFAULT NULL,
  \`distro\` varchar(128) DEFAULT NULL,
  \`package_count\` int unsigned DEFAULT NULL,
  \`collected_at\` bigint unsigned DEFAULT NULL,
  \`inventory_error\` varchar(1024) DEFAULT NULL,
  \`inventory_attempted_at\` bigint unsigned DEFAULT NULL,
  \`requested_at\` bigint unsigned DEFAULT NULL,
  \`matched_db\` varchar(64) DEFAULT NULL,
  \`matched_at\` bigint unsigned DEFAULT NULL,
  \`match_error\` varchar(1024) DEFAULT NULL,
  PRIMARY KEY (\`relay_id\`, \`sbom_key\`),
  CONSTRAINT \`${sbom}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relay}\` (\`id\`) ON DELETE CASCADE
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${target}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`target_key\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_type\` enum('relay','instance','database','app') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`component\` varchar(128) DEFAULT NULL,
  \`image\` varchar(512) DEFAULT NULL,
  \`sbom_key\` varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`running\` tinyint unsigned NOT NULL DEFAULT '1',
  \`observed_at\` bigint unsigned NOT NULL,
  \`inventory_since\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`relay_id\`, \`target_key\`),
  KEY \`${target}_sbom_idx\` (\`relay_id\`, \`sbom_key\`),
  KEY \`${target}_resource_idx\` (\`relay_id\`, \`resource_type\`, \`resource_id\`),
  CONSTRAINT \`${target}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relay}\` (\`id\`) ON DELETE CASCADE
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${finding}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`sbom_key\` varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`finding_key\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`vulnerability_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`package_name\` varchar(255) NOT NULL,
  \`package_version\` varchar(255) NOT NULL,
  \`package_type\` varchar(32) NOT NULL,
  \`package_source\` varchar(255) DEFAULT NULL,
  \`location\` varchar(512) DEFAULT NULL,
  \`severity\` tinyint unsigned NOT NULL,
  \`fix_state\` enum('fixed','not-fixed','wont-fix','unknown') NOT NULL,
  \`fixed_version\` varchar(255) DEFAULT NULL,
  \`risk\` double NOT NULL DEFAULT '0',
  \`first_seen_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`relay_id\`, \`sbom_key\`, \`finding_key\`),
  KEY \`${finding}_vulnerability_idx\` (\`vulnerability_id\`),
  CONSTRAINT \`${finding}_sbom_fk\` FOREIGN KEY (\`relay_id\`, \`sbom_key\`) REFERENCES \`${sbom}\` (\`relay_id\`, \`sbom_key\`) ON DELETE CASCADE
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${vulnerability}\` (
  \`id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`severity\` tinyint unsigned NOT NULL,
  \`description\` text,
  \`url\` varchar(1024) DEFAULT NULL,
  \`cvss\` double DEFAULT NULL,
  \`epss\` double DEFAULT NULL,
  \`known_exploited\` tinyint unsigned NOT NULL DEFAULT '0',
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`)
)`)

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${alert}\` (
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`target_key\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`alert_key\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`alerted_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`relay_id\`, \`target_key\`, \`alert_key\`),
  CONSTRAINT \`${alert}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relay}\` (\`id\`) ON DELETE CASCADE
)`)
  }),
}
