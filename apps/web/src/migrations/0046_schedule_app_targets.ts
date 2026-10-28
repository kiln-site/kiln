import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Schedules can target Apps. Widening the enum keeps every stored target.
export const scheduleAppTargets: Migration = {
  id: 46,
  name: "schedule_app_targets",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const target = databaseTableName("schedule_target")
    const [kind] = yield* sql<{ columnType: string }>`
      SELECT column_type AS columnType
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${target}
        AND column_name = 'target_kind'
    `
    if (!kind || kind.columnType.includes("'app'")) return
    yield* sql.unsafe(
      `ALTER TABLE \`${target}\` MODIFY \`target_kind\` enum('instance','database','relay','app') NOT NULL`
    )
  }),
}
