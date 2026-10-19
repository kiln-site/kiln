import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Hearth's own record of changes people and Hearth itself make. Relay
// changes are recorded as pending under their operation ID before they're
// sent, then given their outcome; a row Hearth couldn't finish, as when it
// restarted mid-change, is settled later by asking the Relay.
export const auditEvents: Migration = {
  id: 17,
  name: "audit_events",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("audit_event")

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`occurred_at\` bigint unsigned NOT NULL,
  \`finished_at\` bigint unsigned DEFAULT NULL,
  \`actor_kind\` enum('user','cli','system') NOT NULL,
  \`actor_user_id\` varchar(36) DEFAULT NULL,
  \`actor_credential_id\` varchar(64) DEFAULT NULL,
  \`action\` varchar(120) NOT NULL,
  \`target_kind\` varchar(32) NOT NULL,
  \`target_id\` varchar(128) NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`operation_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`outcome\` enum('pending','succeeded','failed','not_run','unknown') NOT NULL,
  \`error_code\` varchar(64) DEFAULT NULL,
  \`details\` json DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${table}_operation_unique\` (\`operation_id\`),
  KEY \`${table}_occurred_idx\` (\`occurred_at\`),
  KEY \`${table}_actor_idx\` (\`actor_user_id\`, \`occurred_at\`),
  KEY \`${table}_target_idx\` (\`target_kind\`, \`target_id\`, \`occurred_at\`),
  KEY \`${table}_pending_idx\` (\`relay_id\`, \`outcome\`, \`occurred_at\`)
)`)
  }),
}
