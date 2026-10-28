import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// When someone asked a running operation to stop, which it does at its next
// safe point.
export const operationCancellation: Migration = {
  id: 38,
  name: "operation_cancellation",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${operation}
         AND column_name = 'cancel_requested_at'
    `
    if (Number(found?.count ?? 0) > 0) return
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  ADD COLUMN \`cancel_requested_at\` bigint DEFAULT NULL AFTER \`progress\``)
  }),
}
