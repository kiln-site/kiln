import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A server migration runs as a durable operation, whose lanes and stored
// steps replace its row's lease, claim and step markers: the row keeps how
// far it got and how it ended, and names its operation. One a Hearth from
// before left running has none, and is undone at startup from what the row
// still holds.
export const serverMigrationOperations: Migration = {
  id: 52,
  name: "server_migration_operations",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("server_migration")
    const columns = yield* sql<{ name: string }>`
      SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ${table}
    `
    const has = (column: string) =>
      columns.some((found) => found.name === column)
    const [index] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ${table}
         AND index_name = ${`${table}_running_idx`}
    `
    const changes = [
      ...(Number(index?.count ?? 0) > 0
        ? [`DROP INDEX \`${table}_running_idx\``]
        : []),
      ...[
        "claim_generation",
        "lease_until",
        "finished_parts",
        "destination_created",
      ]
        .filter(has)
        .map((column) => `DROP COLUMN \`${column}\``),
      ...(has("operation_id")
        ? []
        : [
            "ADD COLUMN `operation_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER `id`",
          ]),
    ]
    if (changes.length === 0) return
    yield* sql.unsafe(`ALTER TABLE \`${table}\` ${changes.join(", ")}`)
  }),
}
