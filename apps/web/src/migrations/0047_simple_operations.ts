import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Hearth's operations no longer wait in lanes (docs/hearth-operations.md):
// the lock, scheduler and driver tables go, and the operation table keeps
// only what records a durable operation. Durable ones that waited or were
// granted run now, started by the sweep; their workflows' history stays, so
// one under way resumes where it was. A quick one left open ran in a Hearth
// that's gone.
export const simpleOperations: Migration = {
  id: 47,
  name: "simple_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const operation = databaseTableName("operation")
    const [found] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${operation}
         AND column_name = 'sequence'
    `
    if (Number(found?.count ?? 0) > 0) {
      const now = yield* Clock.currentTimeMillis
      yield* sql.unsafe(
        `UPDATE \`${operation}\`
            SET state = 'interrupted', error = 'Hearth was upgraded while it ran',
                finished_at = ?, updated_at = ?
          WHERE durable = 0 AND state IN ('waiting', 'granted', 'running')`,
        [now, now]
      )
      yield* sql.unsafe(
        `UPDATE \`${operation}\` SET state = 'running', updated_at = ?
          WHERE durable = 1 AND state IN ('waiting', 'granted')`,
        [now]
      )
    }
    for (const table of [
      "operation_lock",
      "operation_scheduler",
      "operation_driver",
    ]) {
      yield* sql.unsafe(`DROP TABLE IF EXISTS \`${databaseTableName(table)}\``)
    }
    if (Number(found?.count ?? 0) === 0) return
    yield* sql.unsafe(`ALTER TABLE \`${operation}\`
  DROP INDEX \`${operation}_sequence_unique\`,
  DROP INDEX \`${operation}_state_idx\`,
  DROP COLUMN \`sequence\`,
  DROP COLUMN \`durable\`,
  DROP COLUMN \`input_hash\`,
  DROP COLUMN \`driver\`,
  DROP COLUMN \`granted_at\`,
  DROP COLUMN \`started_at\`,
  DROP COLUMN \`progress\`,
  CHANGE COLUMN \`admitted_at\` \`created_at\` bigint unsigned NOT NULL,
  MODIFY \`state\` enum('running','succeeded','failed','cancelled','interrupted') NOT NULL,
  ADD KEY \`${operation}_state_idx\` (\`state\`, \`created_at\`)`)
  }),
}
