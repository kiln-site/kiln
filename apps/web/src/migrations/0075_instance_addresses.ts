import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A hostname an instance holds is one row, whatever uses it. A game
// server's addresses were `instance_domain` rows and the names web routes
// answer on, with an App's generated address, `web_hostname` rows; a game
// server's web route on its own address was one of each. They become
// `instance_address`: `game` for a game server's address, pointing at its
// game port, with `routed` and `is_generated` as before.
//
// Every row keeps its ID: Kiln knows the records it made in Cloudflare by
// the `kiln:<row id>` marker in their comments. A game server's route on
// its own address folds into the address's row, which has the record. An
// address being deleted that a route also uses is dropped for the route's
// row instead: a record of it still in Cloudflare is then left for Sync, or
// to delete by hand. A route on the name a rename is moving an address to
// keeps a row of its own until the rename finishes.
//
// MySQL doesn't roll DDL back, so every step is safe to run again: rows are
// copied by their ID, and each old table goes only once copied.
export const instanceAddresses: Migration = {
  id: 75,
  name: "instance_addresses",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const address = databaseTableName("instance_address")
    const domain = databaseTableName("instance_domain")
    const web = databaseTableName("web_hostname")
    const zone = databaseTableName("domain_zone")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${address}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`hostname\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_type\` enum('app','instance') NOT NULL,
  \`resource_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`integration_id\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`zone_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`vanity_domain\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`game\` tinyint(1) NOT NULL DEFAULT '0',
  \`routed\` tinyint(1) NOT NULL DEFAULT '0',
  \`is_generated\` tinyint(1) NOT NULL DEFAULT '0',
  \`is_primary\` tinyint(1) NOT NULL DEFAULT '0',
  \`next_hostname\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`next_vanity_domain\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`public_port\` smallint unsigned DEFAULT NULL,
  \`supports_srv\` tinyint(1) NOT NULL DEFAULT '0',
  \`srv_service\` varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`srv_protocol\` enum('tcp','udp') DEFAULT NULL,
  \`srv_record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`record_type\` enum('A','AAAA','CNAME') DEFAULT NULL,
  \`target\` varchar(253) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`proxied\` tinyint(1) NOT NULL DEFAULT '0',
  \`existing_record_id\` char(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`existing_record_type\` enum('A','AAAA','CNAME') DEFAULT NULL,
  \`existing_record_content\` varchar(255) DEFAULT NULL,
  \`existing_record_proxied\` tinyint(1) DEFAULT NULL,
  \`status\` enum('pending','active','external','error','removing') NOT NULL DEFAULT 'pending',
  \`last_error\` varchar(512) DEFAULT NULL,
  \`attempts\` smallint unsigned NOT NULL DEFAULT '0',
  \`next_attempt_at\` bigint unsigned DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${address}_hostname_unique\` (\`hostname\`),
  KEY \`${address}_resource_idx\` (\`relay_id\`,\`resource_type\`,\`resource_id\`),
  KEY \`${address}_status_idx\` (\`status\`,\`next_attempt_at\`),
  KEY \`${address}_integration_idx\` (\`integration_id\`)
)`)
    const present = Effect.fnUntraced(function* (table: string) {
      const [found] = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ${table}
      `
      return Number(found?.count ?? 0) > 0
    })
    if (yield* present(web)) {
      yield* sql.unsafe(`INSERT IGNORE INTO \`${address}\`
  (id, hostname, relay_id, resource_type, resource_id, integration_id,
   zone_id, vanity_domain, is_generated, routed, record_id, record_type,
   target, proxied, existing_record_id, existing_record_type,
   existing_record_content, existing_record_proxied, status, last_error,
   attempts, next_attempt_at, created_at, updated_at)
SELECT id, LOWER(hostname), relay_id, resource_type, resource_id,
       integration_id, zone_id, vanity_domain, is_generated, routed,
       record_id, record_type, target, proxied, existing_record_id,
       existing_record_type, existing_record_content,
       existing_record_proxied, status, last_error, attempts,
       next_attempt_at, created_at, updated_at
  FROM \`${web}\``)
    }
    if (yield* present(domain)) {
      const domains = yield* sql.unsafe<{
        hostname: string
        id: string
        instanceId: string
        relayId: string
        status: string
      }>(`SELECT id, relay_id AS relayId, instance_id AS instanceId, status,
       LOWER(CONCAT(vanity_label, '.', domain)) AS hostname
  FROM \`${domain}\`
 ORDER BY id`)
      for (const row of domains) {
        // One at a time, each whole: a run stopped between two leaves
        // every address either as it was or carried over.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const [carried] = yield* sql.unsafe<{ id: string }>(
              `SELECT id FROM \`${address}\` WHERE id = ?`,
              [row.id]
            )
            if (carried) return
            // Its game server's web route on the same name.
            const [route] = yield* sql.unsafe<{
              id: string
              routed: number
              zoneId: string | null
            }>(
              `SELECT id, routed, zone_id AS zoneId FROM \`${address}\`
                WHERE hostname = ? AND game = 0 AND relay_id = ?
                  AND resource_type = 'instance' AND resource_id = ?
                FOR UPDATE`,
              [row.hostname, row.relayId.trim(), row.instanceId]
            )
            if (route && row.status === "removing") return
            if (route) {
              yield* sql.unsafe(`DELETE FROM \`${address}\` WHERE id = ?`, [
                route.id,
              ])
            }
            yield* sql.unsafe(
              `INSERT IGNORE INTO \`${address}\`
  (id, hostname, relay_id, resource_type, resource_id, integration_id,
   zone_id, vanity_domain, game, routed, is_primary, next_hostname,
   next_vanity_domain, public_port, supports_srv, srv_service, srv_protocol,
   srv_record_id, record_id, record_type, target, status, last_error,
   attempts, next_attempt_at, created_at, updated_at)
SELECT old.id, LOWER(CONCAT(old.vanity_label, '.', old.domain)),
       old.relay_id, 'instance', old.instance_id, old.integration_id,
       COALESCE(?, configured.zone_id), old.domain, 1, ?, old.is_primary,
       IF(old.next_vanity_label IS NULL OR old.next_domain IS NULL, NULL,
          LOWER(CONCAT(old.next_vanity_label, '.', old.next_domain))),
       IF(old.next_vanity_label IS NULL, NULL, old.next_domain),
       old.public_port, old.supports_srv, old.srv_service, old.srv_protocol,
       old.srv_record_id, old.address_record_id, old.address_record_type,
       old.public_host, old.status, old.last_error, old.attempts,
       old.next_attempt_at, old.created_at, old.updated_at
  FROM \`${domain}\` old
  LEFT JOIN \`${zone}\` configured ON configured.domain = old.domain
 WHERE old.id = ?`,
              [route?.zoneId ?? null, route ? route.routed : 0, row.id]
            )
          })
        )
      }
      yield* sql.unsafe(`DROP TABLE \`${domain}\``)
    }
    if (yield* present(web)) yield* sql.unsafe(`DROP TABLE \`${web}\``)
  }),
}
