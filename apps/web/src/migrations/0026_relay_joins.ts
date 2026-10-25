import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Joins: Relays added from an install command in the Add Relay dialog. A
// join holds the secret and the Hearth client key its command carries, the
// Relay's announcement, and the choices someone confirmed it with, so a
// confirmation that stopped partway carries on (lib/relay-join.server.ts).
//
// Relays also gain `send_installation_id`: whether Hearth sends its
// installation ID when it connects. Relays added before stay as they were;
// joined ones only get it after an explicit replacement is confirmed.
export const relayJoins: Migration = {
  id: 26,
  name: "relay_joins",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const join = databaseTableName("relay_join")
    const relay = databaseTableName("relay")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${join}\` (
  \`id\` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_by\` varchar(36) NOT NULL,
  \`secret_ciphertext\` text,
  \`client_public_key\` text NOT NULL,
  \`client_private_key_ciphertext\` text,
  \`expires_at\` bigint unsigned NOT NULL,
  \`state\` enum('waiting','announced','confirming','needs_review','paired','expired','revoked') NOT NULL DEFAULT 'waiting',
  \`progress\` enum('pairing','saved','connected','installation') DEFAULT NULL,
  \`envelope\` json DEFAULT NULL,
  \`envelope_digest\` char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`announced_at\` bigint unsigned DEFAULT NULL,
  \`intent\` json DEFAULT NULL,
  \`observed_installation\` json DEFAULT NULL,
  \`claim_generation\` int unsigned NOT NULL DEFAULT '0',
  \`lease_until\` bigint unsigned DEFAULT NULL,
  \`claimed_fingerprint\` char(43) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`paired_relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`error\` varchar(512) DEFAULT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${join}_claimed_fingerprint_unique\` (\`claimed_fingerprint\`),
  KEY \`${join}_creator_state_idx\` (\`created_by\`,\`state\`,\`created_at\`)
)`)
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${relay}
    `
    if (
      !columns.some(({ columnName }) => columnName === "send_installation_id")
    ) {
      yield* sql.unsafe(`ALTER TABLE \`${relay}\`
  ADD COLUMN \`send_installation_id\` tinyint(1) NOT NULL DEFAULT '1'`)
    }
  }),
}
