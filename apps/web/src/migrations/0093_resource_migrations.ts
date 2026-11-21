import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

type Sql = SqlClient.SqlClient

/**
 * Moving and duplicating is for every kind of resource, not game servers
 * alone, so its records say so:
 *
 * 1. `server_migration` becomes `resource_migration`. Each row gets the
 *    kind of what it copied, a game server (`instance`) for every one so
 *    far, and its IDs lose "instance" from their names and grow to hold a
 *    volume's, which is longer than an instance's. A copy of several parts
 *    says which one it's on.
 * 2. The notification a copy ends with, and whether someone wants it, go by
 *    `resource.migration`.
 *
 * Each step finds what's left to do, so running it again after a crash
 * carries on where it stopped.
 */
export const resourceMigrations: Migration = {
  id: 93,
  name: "resource_migrations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const before = databaseTableName("server_migration")
    const table = databaseTableName("resource_migration")
    if (
      (yield* tableExists(sql, before)) &&
      !(yield* tableExists(sql, table))
    ) {
      yield* sql.unsafe(`RENAME TABLE \`${before}\` TO \`${table}\``)
    }
    if (yield* columnExists(sql, table, "source_instance_id")) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  CHANGE \`source_instance_id\` \`source_id\` varchar(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CHANGE \`destination_instance_id\` \`destination_id\` varchar(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY \`source_name\` varchar(120) NOT NULL,
  MODIFY \`destination_name\` varchar(120) NOT NULL,
  RENAME INDEX \`${before}_requester_idx\` TO \`${table}_requester_idx\`,
  RENAME INDEX \`${before}_destination_idx\` TO \`${table}_destination_idx\`,
  RENAME INDEX \`${before}_source_idx\` TO \`${table}_source_idx\``)
    }
    if (!(yield* columnExists(sql, table, "kind"))) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`kind\` enum('instance','database','app','volume') NOT NULL DEFAULT 'instance' AFTER \`actor\`,
  ADD COLUMN \`part\` int unsigned NOT NULL DEFAULT '1' AFTER \`transfer_id\`,
  ADD COLUMN \`parts\` int unsigned NOT NULL DEFAULT '1' AFTER \`part\``)
    }
    yield* sql.unsafe(
      `UPDATE \`${databaseTableName("notification")}\`
          SET kind = 'resource.migration' WHERE kind = 'server.migration'`
    )
    // Each person's choices are kept by notification kind, as JSON.
    yield* sql.unsafe(
      `UPDATE \`${databaseTableName("setting")}\`
          SET setting_value = REPLACE(CAST(setting_value AS CHAR), '"server.migration"', '"resource.migration"')
        WHERE CAST(setting_value AS CHAR) LIKE '%"server.migration"%'`
    )
  }),
}

function tableExists(sql: Sql, name: string) {
  return sql<{ found: number }>`
    SELECT 1 AS found FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${name}
  `.pipe(Effect.map((rows) => rows.length > 0))
}

function columnExists(sql: Sql, name: string, column: string) {
  return sql<{ found: number }>`
    SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ${name}
      AND column_name = ${column}
  `.pipe(Effect.map((rows) => rows.length > 0))
}
