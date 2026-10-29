import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// One deletion per resource, of any kind, run as the durable operation
// `resource.delete` (lib/resource-deletion.server.ts). Its row holds what was
// asked for and how far it got: whether a final backup comes first and
// which, when the Relay was first asked to delete it (from then on it can
// only be finished, not kept) and with which of an App's volumes, when the
// Relay confirmed it gone (so a retry only cleans up in Hearth), and each
// attempt's number, which names its operation.
// Finished rows stay, so a deletion is never revived.
//
// The final-delete tables game servers and databases kept are carried over:
// rows still backing up or deleting resume as operations with their backup
// IDs, failed rows stay failed, and completed rows stay completed. MySQL
// doesn't roll DDL back, so every step is safe to run again: rows are
// copied by their resource's key, and each old table goes only once copied.
export const resourceDeletions: Migration = {
  id: 44,
  name: "resource_deletions",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("resource_deletion")
    const relay = databaseTableName("relay")
    const backup = databaseTableName("backup")
    const user = databaseTableName("user")
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table}\` (
  \`id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`relay_id\` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`resource_kind\` enum('instance','database','app','volume') NOT NULL,
  \`resource_id\` varchar(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`final_backup\` tinyint(1) NOT NULL,
  \`storage_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`backup_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  \`status\` enum('pending','backing_up','deleting','failed','completed','cancelling','cancelled') NOT NULL,
  \`error\` text,
  \`attempt\` int unsigned NOT NULL DEFAULT '1',
  \`relay_deleted_at\` bigint unsigned DEFAULT NULL,
  \`relay_deleting_at\` bigint unsigned DEFAULT NULL,
  \`volume_ids\` json DEFAULT NULL,
  \`requested_by\` varchar(36) NOT NULL,
  \`actor\` json NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${table}_resource_unique\` (\`relay_id\`,\`resource_kind\`,\`resource_id\`),
  KEY \`${table}_status_idx\` (\`status\`,\`updated_at\`),
  KEY \`${table}_backup_idx\` (\`backup_id\`),
  CONSTRAINT \`${table}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relay}\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`${table}_backup_fk\` FOREIGN KEY (\`backup_id\`) REFERENCES \`${backup}\` (\`id\`) ON DELETE RESTRICT
)`)
    // A table a stopped run made before these columns.
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    const has = (name: string) =>
      columns.some((column) => column.columnName === name)
    if (!has("relay_deleting_at")) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
        ADD COLUMN \`relay_deleting_at\` bigint unsigned DEFAULT NULL
        AFTER \`relay_deleted_at\``)
    }
    if (!has("volume_ids")) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
        ADD COLUMN \`volume_ids\` json DEFAULT NULL
        AFTER \`relay_deleting_at\``)
    }
    for (const [legacy, kind] of [
      ["backup_final_delete", "instance"],
      ["backup_final_database_delete", "database"],
    ] as const) {
      const old = databaseTableName(legacy)
      const [present] = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ${old}
      `
      if (!present || Number(present.count) === 0) continue
      // Its person as server moves keep one, from their account now; the
      // operation reads their standing again before it acts. A Relay
      // removed since took its deletions with it.
      yield* sql.unsafe(
        `INSERT IGNORE INTO \`${table}\`
           (id, relay_id, resource_kind, resource_id, final_backup,
            storage_id, backup_id, status, error, attempt, relay_deleted_at,
            relay_deleting_at, requested_by, actor, created_at, updated_at)
         SELECT UUID(), old.relay_id, ?, old.target_id, 1, NULL,
                old.backup_id, old.status, old.error, 1,
                IF(old.status = 'completed', old.updated_at, NULL),
                IF(old.status IN ('deleting', 'completed'),
                  old.updated_at, NULL),
                old.requested_by,
                JSON_OBJECT(
                  'id', old.requested_by,
                  'email', COALESCE(person.email, ''),
                  'emailVerified', COALESCE(person.emailVerified, 0) = 1,
                  'isDevelopmentBypass', FALSE,
                  'name', COALESCE(person.name, ''),
                  'role', 'user',
                  'twoFactorEnabled', COALESCE(person.twoFactorEnabled, 0) = 1
                ),
                old.created_at, old.updated_at
           FROM \`${old}\` old
           JOIN \`${relay}\` relay ON relay.id = old.relay_id
           LEFT JOIN \`${user}\` person ON person.id = old.requested_by`,
        [kind]
      )
      yield* sql.unsafe(`DROP TABLE \`${old}\``)
    }
    // Rows an earlier run of this migration carried over before it took
    // the Relay deletion's start: one deleting, or done, had its Relay
    // asked. Only carried-over rows exist until it finishes, and a start
    // already recorded stays.
    yield* sql.unsafe(
      `UPDATE \`${table}\`
          SET relay_deleting_at = updated_at
        WHERE relay_deleting_at IS NULL
          AND status IN ('deleting', 'completed')`
    )
  }),
}
