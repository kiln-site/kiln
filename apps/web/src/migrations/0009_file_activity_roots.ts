import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Recent and pinned files belonged to servers only. Rows now key on the file
// root (a server ID, `app:<appId>`, or a Relay's host files), and each kind
// keeps a cascading key so deleting its server, app, or Relay drops them.
export const fileActivityRoots: Migration = {
  id: 9,
  name: "file_activity_roots",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("file_activity")
    const appTable = databaseTableName("app")
    const relayTable = databaseTableName("relay")

    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    if (!columns.some((column) => column.columnName === "root_id")) {
      yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`root_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER \`relay_id\`,
  ADD COLUMN \`app_id\` char(40) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER \`instance_id\``)
    }
    yield* sql.unsafe(
      `UPDATE \`${table}\` SET \`root_id\` = \`instance_id\` WHERE \`root_id\` IS NULL`
    )

    const primary = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ${table}
        AND index_name = 'PRIMARY'
    `
    if (primary.some((column) => column.columnName === "root_id")) return
    // One statement, so the instance key always has an index to use.
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  DROP PRIMARY KEY,
  MODIFY \`root_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY \`instance_id\` char(40) NULL,
  ADD PRIMARY KEY (\`relay_id\`,\`root_id\`,\`path_hash\`),
  ADD KEY \`${table}_instance_idx\` (\`relay_id\`,\`instance_id\`),
  DROP KEY \`${table}_recent_idx\`,
  ADD KEY \`${table}_root_recent_idx\` (\`relay_id\`,\`root_id\`,\`pinned\`,\`last_viewed_at\`),
  ADD CONSTRAINT \`${table}_app_fk\` FOREIGN KEY (\`app_id\`) REFERENCES \`${appTable}\` (\`app_id\`) ON DELETE CASCADE,
  ADD CONSTRAINT \`${table}_relay_fk\` FOREIGN KEY (\`relay_id\`) REFERENCES \`${relayTable}\` (\`id\`) ON DELETE CASCADE`)
  }),
}
