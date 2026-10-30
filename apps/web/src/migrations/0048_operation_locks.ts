import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A durable operation holds its lanes until it ends, across restarts: the
// locks it holds are kept with it, for the next Hearth to take back.
export const operationLocks: Migration = {
  id: 48,
  name: "operation_locks",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${operation}
         AND column_name = 'locks'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  ADD COLUMN \`locks\` json DEFAULT NULL AFTER \`input\``)
  }),
}
