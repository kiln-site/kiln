import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A move deploys its copy before handing anything to it, and says so while
// it does. Widening the enum keeps every stored step.
export const resourceMigrationDeploy: Migration = {
  id: 102,
  name: "resource_migration_deploy",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("resource_migration")
    const [step] = yield* sql<{ columnType: string }>`
      SELECT column_type AS columnType
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ${table}
        AND column_name = 'step'
    `
    if (!step || step.columnType.includes("'deploy'")) return
    yield* sql.unsafe(
      `ALTER TABLE \`${table}\` MODIFY \`step\` enum('backup','stop','create','provision','copy','deploy','finish') NOT NULL`
    )
  }),
}
