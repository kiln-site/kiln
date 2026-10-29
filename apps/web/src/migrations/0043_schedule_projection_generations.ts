import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What Hearth sends a Relay for one schedule changes without the schedule
// changing, as when a destination is disabled or a target's backups are
// turned off, which decides whether its scheduled backups may run. Each
// version of it gets a generation, raised whenever one is sent or something
// it depends on changes; the Relay keeps the newest it has had, and Hearth
// counts a schedule delivered only once the Relay has the newest generation
// Hearth issued. Safe to run again: each column is added once.
export const scheduleProjectionGenerations: Migration = {
  id: 43,
  name: "schedule_projection_generations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const deployment = databaseTableName("schedule_deployment")
    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${deployment}
    `
    const has = (name: string) =>
      columns.some((column) => column.columnName === name)
    if (!has("desired_generation")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${deployment}\`
           ADD COLUMN \`desired_generation\` bigint unsigned NOT NULL DEFAULT '0'`
      )
    }
    if (!has("acknowledged_generation")) {
      yield* sql.unsafe(
        `ALTER TABLE \`${deployment}\`
           ADD COLUMN \`acknowledged_generation\` bigint unsigned DEFAULT NULL`
      )
    }
  }),
}
