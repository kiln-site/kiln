import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// What a running operation last said it was doing, for whoever watches it:
// a message and, when it can count, how far along it is.
export const operationProgress: Migration = {
  id: 37,
  name: "operation_progress",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${operation}
         AND column_name = 'progress'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  ADD COLUMN \`progress\` json DEFAULT NULL AFTER \`error\``)
  }),
}
