import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { MigrationError } from "@/effect/errors"
import { databaseTablePrefix } from "@/lib/database-config"

import { baselineTables } from "./baseline-schema"

// Creates the schema on a fresh database. An install upgrading from the last
// release that used the legacy migration scripts already has these tables,
// so it is only checked against the baseline and recorded.
export const baseline: Migration = {
  id: 1,
  name: "baseline",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const prefix = databaseTablePrefix()
    const rows = yield* sql<{ tableName: string; columnName: string }>`
      SELECT table_name AS tableName, column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN ${sql.in(baselineTables.map((table) => prefix + table.name))}
    `
    // Table names fold to lower case on some MySQL hosts.
    const existing = new Map<string, Set<string>>()
    for (const row of rows) {
      const table = row.tableName.toLowerCase()
      const columns = existing.get(table) ?? new Set()
      columns.add(row.columnName.toLowerCase())
      existing.set(table, columns)
    }

    const mismatched = baselineTables.filter((table) => {
      const columns = existing.get((prefix + table.name).toLowerCase())
      return (
        columns !== undefined &&
        (columns.size !== table.columns.length ||
          table.columns.some((column) => !columns.has(column.toLowerCase())))
      )
    })
    if (mismatched.length > 0) {
      return yield* new MigrationError({
        message: `These tables do not match the schema this version upgrades from: ${mismatched
          .map((table) => prefix + table.name)
          .join(
            ", "
          )}. Update to the latest Kiln release first, then to this one.`,
      })
    }

    for (const table of baselineTables) {
      if (existing.has((prefix + table.name).toLowerCase())) continue
      yield* sql.unsafe(table.create.replaceAll("`kiln_", `\`${prefix}`))
    }
  }),
}
