import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Schedules are stored and run in UTC, and Hearth shows their times in each
// viewer's browser. The time zone saved with a schedule never decided when it
// ran, so dropping it changes no schedule.
export const schedulesInUtc: Migration = {
  id: 60,
  name: "schedules_in_utc",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("schedule")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    if (!columns.some((column) => column.columnName === "timezone")) return
    yield* sql.unsafe(`ALTER TABLE \`${table}\` DROP COLUMN \`timezone\``)
  }),
}
