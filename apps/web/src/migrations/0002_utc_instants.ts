import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTablePrefix } from "@/lib/database-config"

import { baselineTables } from "./baseline-schema"

// better-auth writes JS Dates, so its tables keep a date type. DATETIME is
// stored as written, unlike TIMESTAMP, which MySQL shifts by time zone.
const authTables = [
  "user",
  "session",
  "account",
  "verification",
  "twoFactor",
  "passkey",
  "rateLimit",
]

// Wall-clock numbers (YYYYMMDDhhmmss) start near 1.9e13; epoch
// milliseconds stay below 1e13 until the year 2286.
const wallClockFloor = 10_000_000_000_000

// Stores every Kiln time as UTC epoch milliseconds in BIGINT UNSIGNED and
// drops MySQL clock defaults, so time zones never reach the database. Each
// column goes TIMESTAMP -> DECIMAL(17,3) -> epoch value -> BIGINT in place,
// keeping its indexes, and a rerun resumes from whichever step it reached.
export const utcInstants: Migration = {
  id: 2,
  name: "utc_instants",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const prefix = databaseTablePrefix()
    const tables = new Map(
      baselineTables.map((table) => [
        (prefix + table.name).toLowerCase(),
        authTables.includes(table.name),
      ])
    )

    // Pin one connection: TIMESTAMP values convert through its time zone.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET time_zone = '+00:00'`
        const rows = yield* sql<{
          tableName: string
          columnName: string
          dataType: string
          nullable: string
        }>`
          SELECT table_name AS tableName, column_name AS columnName,
            data_type AS dataType, is_nullable AS nullable
          FROM information_schema.columns
          WHERE table_schema = DATABASE()
            AND (data_type = 'timestamp' OR column_type = 'decimal(17,3)')
          ORDER BY table_name, ordinal_position
        `
        const byTable = new Map<string, Array<(typeof rows)[number]>>()
        for (const row of rows) {
          if (!tables.has(row.tableName.toLowerCase())) continue
          const columns = byTable.get(row.tableName) ?? []
          columns.push(row)
          byTable.set(row.tableName, columns)
        }

        for (const [table, columns] of byTable) {
          const nullability = (column: (typeof columns)[number]) =>
            sql.literal(column.nullable === "YES" ? "NULL" : "NOT NULL")
          const modify = (
            subset: ReadonlyArray<(typeof columns)[number]>,
            type: string
          ) =>
            sql`ALTER TABLE ${sql(table)} ${sql.csv(
              subset.map(
                (column) =>
                  sql`MODIFY ${sql(column.columnName)} ${sql.literal(type)} ${nullability(column)}`
              )
            )}`

          const timestamps = columns.filter(
            (column) => column.dataType === "timestamp"
          )
          if (tables.get(table.toLowerCase())) {
            if (timestamps.length > 0) yield* modify(timestamps, "DATETIME(3)")
            continue
          }

          if (timestamps.length > 0) {
            yield* modify(timestamps, "DECIMAL(17,3)")
          }
          for (const column of columns) {
            const name = sql(column.columnName)
            yield* sql`
              UPDATE ${sql(table)}
              SET ${name} = ROUND(UNIX_TIMESTAMP(${name}) * 1000)
              WHERE ${name} >= ${wallClockFloor}
            `
          }
          yield* modify(columns, "BIGINT UNSIGNED")
        }
      })
    )
  }),
}
