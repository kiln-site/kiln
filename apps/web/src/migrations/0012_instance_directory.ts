import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Stable game server metadata, so the Game Servers table can render from
// Hearth without waiting for every Relay.
export const instanceDirectory: Migration = {
  id: 12,
  name: "instance_directory",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("instance")
    // DDL is not transactional; a retry after a crash finds the column.
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    if (columns.some((column) => column.columnName === "directory_metadata"))
      return
    yield* sql.unsafe(
      `ALTER TABLE \`${table}\` ADD COLUMN \`directory_metadata\` json DEFAULT NULL`
    )
  }),
}
