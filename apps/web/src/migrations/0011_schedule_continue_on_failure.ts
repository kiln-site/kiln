import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A schedule can keep running a target's later actions after one fails, so a
// failed backup between Stop and Start still brings the server back.
export const scheduleContinueOnFailure: Migration = {
  id: 11,
  name: "schedule_continue_on_failure",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("schedule")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    if (columns.some((column) => column.columnName === "continue_on_failure"))
      return
    yield* sql.unsafe(`ALTER TABLE \`${table}\`
  ADD COLUMN \`continue_on_failure\` tinyint(1) NOT NULL DEFAULT '0' AFTER \`enabled\``)
  }),
}
