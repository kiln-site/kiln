import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

/**
 * A copy keeps the parts it settled on, each a root on either Relay, so
 * undoing it discards exactly the transfers it started. An App's parts come
 * from its settings and its Relays' volumes, which can change while it's
 * copied. Running it again adds nothing more.
 */
export const resourceMigrationParts: Migration = {
  id: 94,
  name: "resource_migration_parts",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("resource_migration")
    const found = yield* sql<{ found: number }>`
      SELECT 1 AS found FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${table}
        AND column_name = 'part_roots'
    `
    if (found.length === 0) {
      yield* sql.unsafe(
        `ALTER TABLE \`${table}\` ADD COLUMN \`part_roots\` json NULL AFTER \`parts\``
      )
    }
  }),
}
