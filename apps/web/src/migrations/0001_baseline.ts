import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { MigrationError } from "@/effect/errors"
import { databaseTablePrefix } from "@/lib/database-config"

import { baselineTables } from "./baseline-schema"

interface ColumnDefinition {
  readonly type: string
  readonly nullable: boolean
  // Only columns that declare a collation are checked; the rest follow the
  // server's default, which varies between installs.
  readonly collation: string | undefined
}

// Column lines as SHOW CREATE TABLE prints them, e.g.
// `status` enum('running','failed') NOT NULL
const columnLine =
  /^ {2}`(\w+)` (enum\([^)]*\)|\w+(?:\(\d+\))?(?: unsigned)?)(.*)$/gm

function columnDefinitions(create: string) {
  const columns = new Map<string, ColumnDefinition>()
  for (const [, name, type, rest] of create.matchAll(columnLine)) {
    columns.set(name.toLowerCase(), {
      type,
      nullable: !rest.includes(" NOT NULL"),
      collation: /COLLATE (\w+)/.exec(rest)?.[1],
    })
  }
  return columns
}

// Creates the schema on a fresh database. An install upgrading from the last
// release that used the legacy migration scripts already has these tables,
// so it is only checked against the baseline and recorded.
export const baseline: Migration = {
  id: 1,
  name: "baseline",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const prefix = databaseTablePrefix()
    const rows = yield* sql<{
      tableName: string
      columnName: string
      columnType: string
      nullable: string
      collation: string | null
    }>`
      SELECT table_name AS tableName, column_name AS columnName,
        column_type AS columnType, is_nullable AS nullable,
        collation_name AS collation
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN ${sql.in(baselineTables.map((table) => prefix + table.name))}
    `
    // Table names fold to lower case on some MySQL hosts.
    const existing = new Map<string, Map<string, (typeof rows)[number]>>()
    for (const row of rows) {
      const table = row.tableName.toLowerCase()
      const columns = existing.get(table) ?? new Map()
      columns.set(row.columnName.toLowerCase(), row)
      existing.set(table, columns)
    }

    const mismatched: Array<string> = []
    for (const table of baselineTables) {
      const tableName = (prefix + table.name).toLowerCase()
      const columns = existing.get(tableName)
      if (columns === undefined) continue
      const expected = columnDefinitions(table.create)
      const differing = [
        ...new Set([...expected.keys(), ...columns.keys()]),
      ].filter((name) => {
        const definition = expected.get(name)
        const column = columns.get(name)
        return (
          definition === undefined ||
          column === undefined ||
          column.columnType !== definition.type ||
          (column.nullable === "YES") !== definition.nullable ||
          (definition.collation !== undefined &&
            column.collation !== definition.collation)
        )
      })
      if (differing.length > 0) {
        mismatched.push(`${prefix + table.name} (${differing.join(", ")})`)
      }
    }
    if (mismatched.length > 0) {
      return yield* new MigrationError({
        message: `These tables do not match the schema this version upgrades from: ${mismatched.join(
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
