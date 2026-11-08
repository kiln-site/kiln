import { Array as Arr, Effect } from "effect"
import { SqlClient } from "effect/sql"

import { databaseTablePrefix } from "@/lib/database-config"

/**
 * A copy of Hearth's tables, taken before an update's migrations run and put
 * back if one fails, so the release Hearth rolls back to finds the database
 * it left. Each table is copied beside itself, and its definition saved, in
 * the same database: no tools or volumes beyond what migrations already use.
 *
 * The list of copies is written last, in one statement, so a snapshot that
 * lists its tables is complete. One found when Hearth starts belongs to a
 * start that stopped partway (killed while migrating, or while restoring),
 * and is restored before anything else; one that lists nothing is left over
 * from taking it, and is dropped.
 */

type Sql = SqlClient.SqlClient

interface SnapshotTable {
  readonly position: number
  readonly original: string
  readonly copy: string
  readonly definition: string
}

const listName = () => `${databaseTablePrefix()}snapshot`
const copyName = (position: number) => `${listName()}_${position}`
const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``

/** Hearth's tables, by its prefix, without the snapshot's own. */
const hearthTables = Effect.fnUntraced(function* (sql: Sql) {
  const prefix = databaseTablePrefix()
  const list = listName()
  const rows = yield* sql<{ name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
  `
  return rows
    .map((row) => row.name)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name !== list &&
        !name.startsWith(`${list}_`)
    )
    .sort()
})

// Generated columns can't be written; none of Hearth's are, but a copy
// shouldn't depend on that. A column whose default is an expression, such as
// CURRENT_TIMESTAMP, is written like any other: MySQL marks it
// DEFAULT_GENERATED, so only a generation expression tells them apart.
const writableColumns = Effect.fnUntraced(function* (sql: Sql, table: string) {
  const rows = yield* sql<{ name: string }>`
    SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ${table}
      AND COALESCE(generation_expression, '') = ''
    ORDER BY ordinal_position
  `
  return rows.map((row) => quote(row.name)).join(", ")
})

const copyRows = Effect.fnUntraced(function* (
  sql: Sql,
  from: string,
  to: string
) {
  const columns = yield* writableColumns(sql, to)
  yield* sql.unsafe(
    `INSERT INTO ${quote(to)} (${columns}) SELECT ${columns} FROM ${quote(from)}`
  )
})

const dropSnapshotTables = Effect.fnUntraced(function* (sql: Sql) {
  const list = listName()
  const rows = yield* sql<{ name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `
  const copies = rows
    .map((row) => row.name)
    .filter((name) => name.startsWith(`${list}_`))
  // The list first: without it, what's left is never restored.
  yield* sql.unsafe(`DROP TABLE IF EXISTS ${quote(list)}`)
  for (const copy of copies) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quote(copy)}`)
  }
})

const savedTables = Effect.fnUntraced(function* (sql: Sql) {
  const list = listName()
  const [found] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${list}
  `
  if (Number(found?.count ?? 0) === 0) return []
  const rows = yield* sql.unsafe<{
    position: number
    original_table: string
    copy_table: string
    definition: string
  }>(
    `SELECT position, original_table, copy_table, definition
     FROM ${quote(list)} ORDER BY position`
  )
  return rows.map(
    (row): SnapshotTable => ({
      copy: row.copy_table,
      definition: row.definition,
      original: row.original_table,
      position: Number(row.position),
    })
  )
})

/** Copies every Hearth table, replacing any incomplete snapshot. */
export const takeMigrationSnapshot = Effect.fn("database.snapshot.take")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    yield* dropSnapshotTables(sql)
    const tables = yield* hearthTables(sql)
    const saved: Array<SnapshotTable> = []
    for (const [position, original] of tables.entries()) {
      const [created] = yield* sql.unsafe<Record<string, string>>(
        `SHOW CREATE TABLE ${quote(original)}`
      )
      const definition = created?.["Create Table"]
      if (!definition) {
        return yield* Effect.fail(
          new Error(`Could not read the definition of ${original}`)
        )
      }
      const copy = copyName(position)
      yield* sql.unsafe(`CREATE TABLE ${quote(copy)} LIKE ${quote(original)}`)
      yield* copyRows(sql, original, copy)
      saved.push({ copy, definition, original, position })
    }
    const list = listName()
    yield* sql.unsafe(`CREATE TABLE ${quote(list)} (
  \`position\` int unsigned NOT NULL,
  \`original_table\` varchar(64) NOT NULL,
  \`copy_table\` varchar(64) NOT NULL,
  \`definition\` mediumtext NOT NULL,
  PRIMARY KEY (\`position\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    const rows = saved.map((table) => ({
      copy_table: table.copy,
      definition: table.definition,
      original_table: table.original,
      position: table.position,
    }))
    if (Arr.isArrayNonEmpty(rows)) {
      yield* sql`INSERT INTO ${sql(list)} ${sql.insert(rows)}`
    }
    yield* Effect.logInfo("Saved the database before migrating", {
      tables: saved.length,
    })
  }
)

/**
 * Puts the snapshot back: every Hearth table as it was, and none the failed
 * migrations added. Safe to repeat if it stops partway, since the copies are
 * only dropped once it's done.
 */
export const restoreMigrationSnapshot = Effect.fn("database.snapshot.restore")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const saved = yield* savedTables(sql)
    if (saved.length === 0) {
      yield* dropSnapshotTables(sql)
      return false
    }
    // One connection throughout, so foreign key checks stay off for it.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET FOREIGN_KEY_CHECKS = 0`
        for (const table of yield* hearthTables(sql)) {
          yield* sql.unsafe(`DROP TABLE ${quote(table)}`)
        }
        for (const table of saved) {
          yield* sql.unsafe(table.definition)
          yield* copyRows(sql, table.copy, table.original)
        }
      }).pipe(Effect.ensuring(sql`SET FOREIGN_KEY_CHECKS = 1`.pipe(Effect.ignore)))
    )
    yield* dropSnapshotTables(sql)
    return true
  }
)

/** Drops the snapshot once the migrations it protected have finished. */
export const dropMigrationSnapshot = Effect.fn("database.snapshot.drop")(
  function* () {
    yield* dropSnapshotTables(yield* SqlClient.SqlClient)
  }
)
