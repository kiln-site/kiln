import { DatabaseSync, type StatementSync } from "node:sqlite"

import type {
  DatabaseChange,
  DatabaseColumn,
  DatabaseMutateInput,
  DatabaseMutateResult,
  DatabaseOverview,
  DatabaseQueryInput,
  DatabaseQueryResult,
  DatabaseRowKey,
  DatabaseRows,
  DatabaseRowsInput,
  DatabaseTable,
  DatabaseValue,
} from "@workspace/contracts"
import { DATABASE_BROWSER_COUNT_CAP } from "@workspace/contracts"

const BUSY_TIMEOUT_MS = 3_000
const BLOB_PREVIEW_BYTES = 1_024
const ROWID_ALIASES = ["rowid", "_rowid_", "oid"] as const
// Stable sqlite3.h authorizer codes; @types/node 22 does not declare them yet.
const SQLITE_OK = 0
const SQLITE_DENY = 1
const SQLITE_ATTACH = 24
const SQLITE_DETACH = 25

interface HardenedDatabaseSync {
  enableDefensive?: (active: boolean) => void
  setAuthorizer?: (callback: (action: number) => number) => void
}

export class DatabaseBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function openSqliteDatabase(path: string, readOnly: boolean) {
  const database = new DatabaseSync(path, {
    readOnly,
    timeout: BUSY_TIMEOUT_MS,
  })
  const hardened = database as unknown as HardenedDatabaseSync
  if (!hardened.enableDefensive || !hardened.setAuthorizer) {
    database.close()
    throw new DatabaseBrowserError(
      "unsupported_runtime",
      "This Relay's Node.js runtime cannot safely open databases. Update the Relay."
    )
  }
  hardened.enableDefensive(true)
  // Queries run with the Relay's filesystem access, so they must never reach
  // files outside the opened database (ATTACH and VACUUM INTO both attach).
  hardened.setAuthorizer((action) =>
    action === SQLITE_ATTACH || action === SQLITE_DETACH
      ? SQLITE_DENY
      : SQLITE_OK
  )
  return database
}

export function sqliteOverview(
  database: DatabaseSync
): Omit<DatabaseOverview, "modifiedAt" | "readOnly" | "sizeBytes"> {
  const version = database.prepare("SELECT sqlite_version() AS version").get()
  return {
    engine: "sqlite",
    engineVersion: String(version?.version ?? ""),
    tables: listTables(database),
  }
}

export function sqliteRows(
  database: DatabaseSync,
  input: DatabaseRowsInput
): DatabaseRows {
  const table = requireTable(database, input.table)
  const columns = table.columns
  const rowIdAlias =
    table.rowIdentity === "rowid" ? unshadowedRowIdAlias(columns) : null
  if (input.sort && !columns.some(({ name }) => name === input.sort?.column)) {
    throw new DatabaseBrowserError(
      "unknown_column",
      `Unknown column ${input.sort.column}`
    )
  }

  const selected = columns.map(({ name }) => quoteIdentifier(name))
  if (rowIdAlias) selected.unshift(rowIdAlias)
  const search = input.search?.trim()
  const where =
    search && columns.length > 0
      ? `WHERE ${columns
          .map(
            ({ name }) =>
              `CAST(${quoteIdentifier(name)} AS TEXT) LIKE ? ESCAPE '\\'`
          )
          .join(" OR ")}`
      : ""
  const searchParameters = where
    ? columns.map(() => `%${escapeLike(search ?? "")}%`)
    : []
  const order = input.sort
    ? `ORDER BY ${quoteIdentifier(input.sort.column)} ${input.sort.direction === "desc" ? "DESC" : "ASC"}`
    : defaultOrder(table, rowIdAlias)
  const from = `FROM ${quoteIdentifier(table.name)} ${where}`

  const statement = database.prepare(
    `SELECT ${selected.join(", ")} ${from} ${order} LIMIT ? OFFSET ?`
  )
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  const raw = statement.all(
    ...searchParameters,
    input.limit,
    input.offset
  ) as unknown as Array<Array<unknown>>

  const counted = database
    .prepare(`SELECT count(*) AS total FROM (SELECT 1 ${from} LIMIT ?)`)
    .get(...searchParameters, DATABASE_BROWSER_COUNT_CAP + 1)
  const total = Number(counted?.total ?? 0)

  const primaryKey = primaryKeyColumns(columns)
  const keys: Array<DatabaseRowKey> | null =
    table.rowIdentity === "rowid"
      ? raw.map((row) => ({ rowid: encodeValue(row[0], Infinity) }))
      : table.rowIdentity === "primary-key"
        ? raw.map((row) =>
            Object.fromEntries(
              primaryKey.map((column) => [
                column.name,
                encodeValue(
                  row[columns.indexOf(column) + (rowIdAlias ? 1 : 0)],
                  Infinity
                ),
              ])
            )
          )
        : null

  return {
    columns: columns.map(({ name, type }) => ({ name, type: type || null })),
    keys,
    offset: input.offset,
    rows: raw.map((row) =>
      (rowIdAlias ? row.slice(1) : row).map((value) =>
        encodeValue(value, BLOB_PREVIEW_BYTES)
      )
    ),
    total: Math.min(total, DATABASE_BROWSER_COUNT_CAP),
    totalCapped: total > DATABASE_BROWSER_COUNT_CAP,
  }
}

export function sqliteQuery(
  database: DatabaseSync,
  input: DatabaseQueryInput
): DatabaseQueryResult {
  const statements = splitSqlStatements(input.sql)
  if (statements.length === 0) {
    throw new DatabaseBrowserError("empty_query", "The query is empty")
  }
  const started = performance.now()
  let changes: number | null = null
  let result: Omit<DatabaseQueryResult, "changes" | "durationMs"> = {
    columns: [],
    rows: [],
    truncated: false,
  }

  for (const sql of statements) {
    const statement = database.prepare(sql)
    const columns = statement.columns()
    if (columns.length === 0) {
      const outcome = statement.run()
      changes = (changes ?? 0) + Number(outcome.changes)
      result = { columns: [], rows: [], truncated: false }
      continue
    }
    result = readStatement(statement, columns, input.maxRows)
  }

  return {
    ...result,
    changes,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  }
}

export function sqliteMutate(
  database: DatabaseSync,
  input: DatabaseMutateInput
): DatabaseMutateResult {
  const table = requireTable(database, input.table)
  if (table.kind !== "table" || !table.rowIdentity) {
    throw new DatabaseBrowserError(
      "read_only_table",
      `${table.name} has no primary key or rowid, so its rows cannot be edited`
    )
  }
  const writable = new Set(
    table.columns.filter(({ generated }) => !generated).map(({ name }) => name)
  )

  database.exec("BEGIN IMMEDIATE")
  try {
    let applied = 0
    for (const [index, change] of input.changes.entries()) {
      const changed = applyChange(database, table, writable, change)
      if (changed === 0 && change.kind !== "insert") {
        throw new DatabaseBrowserError(
          "row_changed",
          `Change ${index + 1} no longer matches its row. It was edited or deleted since the table was loaded; refresh and try again.`
        )
      }
      applied += changed
    }
    database.exec("COMMIT")
    return { applied }
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw error
  }
}

function applyChange(
  database: DatabaseSync,
  table: DatabaseTable,
  writable: ReadonlySet<string>,
  change: DatabaseChange
) {
  const tableName = quoteIdentifier(table.name)
  if (change.kind === "insert") {
    const entries = writableEntries(change.values, writable)
    const statement =
      entries.length === 0
        ? database.prepare(`INSERT INTO ${tableName} DEFAULT VALUES`)
        : database.prepare(
            `INSERT INTO ${tableName} (${entries
              .map(([name]) => quoteIdentifier(name))
              .join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`
          )
    return Number(
      statement.run(...entries.map(([, value]) => decodeValue(value))).changes
    )
  }

  const key = keyCondition(table, change.key)
  if (change.kind === "delete") {
    return Number(
      database
        .prepare(`DELETE FROM ${tableName} WHERE ${key.sql}`)
        .run(...key.parameters).changes
    )
  }

  const entries = writableEntries(change.values, writable)
  if (entries.length === 0) return 1
  const guards = Object.entries(change.original).filter(
    ([name, value]) =>
      table.columns.some((column) => column.name === name) &&
      !isTruncatedBlob(value)
  )
  const statement = database.prepare(
    `UPDATE ${tableName} SET ${entries
      .map(([name]) => `${quoteIdentifier(name)} = ?`)
      .join(", ")} WHERE ${[
      key.sql,
      ...guards.map(([name]) => `${quoteIdentifier(name)} IS ?`),
    ].join(" AND ")}`
  )
  return Number(
    statement.run(
      ...entries.map(([, value]) => decodeValue(value)),
      ...key.parameters,
      ...guards.map(([, value]) => decodeValue(value))
    ).changes
  )
}

function writableEntries(
  values: Record<string, DatabaseValue>,
  writable: ReadonlySet<string>
) {
  const entries = Object.entries(values)
  for (const [name] of entries) {
    if (!writable.has(name)) {
      throw new DatabaseBrowserError(
        "unknown_column",
        `Column ${name} does not exist or cannot be written`
      )
    }
  }
  return entries
}

function keyCondition(table: DatabaseTable, key: DatabaseRowKey) {
  if (table.rowIdentity === "rowid") {
    if (!("rowid" in key)) {
      throw new DatabaseBrowserError("invalid_key", "Row key is missing rowid")
    }
    return {
      parameters: [decodeValue(key.rowid ?? null)],
      sql: `${unshadowedRowIdAlias(table.columns)} = ?`,
    }
  }
  const primaryKey = primaryKeyColumns(table.columns)
  if (
    primaryKey.length !== Object.keys(key).length ||
    primaryKey.some(({ name }) => !(name in key))
  ) {
    throw new DatabaseBrowserError(
      "invalid_key",
      "Row key does not match the table's primary key"
    )
  }
  return {
    parameters: primaryKey.map(({ name }) => decodeValue(key[name] ?? null)),
    sql: primaryKey
      .map(({ name }) => `${quoteIdentifier(name)} IS ?`)
      .join(" AND "),
  }
}

function readStatement(
  statement: StatementSync,
  columns: ReturnType<StatementSync["columns"]>,
  maxRows: number
) {
  statement.setReadBigInts(true)
  statement.setReturnArrays(true)
  const rows: Array<Array<DatabaseValue>> = []
  let truncated = false
  for (const row of statement.iterate() as Iterable<Array<unknown>>) {
    if (rows.length >= maxRows) {
      truncated = true
      break
    }
    rows.push(row.map((value) => encodeValue(value, BLOB_PREVIEW_BYTES)))
  }
  return {
    columns: columns.map(({ name, type }) => ({ name, type: type ?? null })),
    rows,
    truncated,
  }
}

function listTables(database: DatabaseSync): Array<DatabaseTable> {
  const entries = database
    .prepare(
      `SELECT l.name, l.type, l.wr, s.sql
       FROM pragma_table_list AS l
       LEFT JOIN sqlite_schema AS s ON s.name = l.name
       WHERE l.schema = 'main'
         AND l.type IN ('table', 'view', 'virtual')
         AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY l.name COLLATE NOCASE`
    )
    .all() as Array<{
    name: string
    sql: string | null
    type: string
    wr: number
  }>

  const columnStatement = database.prepare(
    'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)'
  )
  return entries.map((entry) => {
    const columns = (
      columnStatement.all(entry.name) as Array<{
        dflt_value: string | null
        hidden: number
        name: string
        notnull: number
        pk: number
        type: string
      }>
    )
      .filter(({ hidden }) => hidden !== 1)
      .map(
        (column): DatabaseColumn => ({
          defaultValue: column.dflt_value,
          generated: column.hidden === 2 || column.hidden === 3,
          name: column.name,
          nullable: column.notnull === 0 && column.pk === 0,
          primaryKey: column.pk,
          type: column.type,
        })
      )
    const kind = entry.type === "view" ? "view" : "table"
    const rowIdentity =
      entry.type !== "table"
        ? null
        : columns.some(({ primaryKey }) => primaryKey > 0)
          ? "primary-key"
          : entry.wr === 0
            ? "rowid"
            : null
    return { columns, kind, name: entry.name, rowIdentity, sql: entry.sql }
  })
}

function requireTable(database: DatabaseSync, name: string) {
  const table = listTables(database).find((entry) => entry.name === name)
  if (!table) {
    throw new DatabaseBrowserError("unknown_table", `Unknown table ${name}`)
  }
  return table
}

function primaryKeyColumns(columns: ReadonlyArray<DatabaseColumn>) {
  return columns
    .filter(({ primaryKey }) => primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey)
}

function defaultOrder(table: DatabaseTable, rowIdAlias: string | null) {
  if (rowIdAlias) return `ORDER BY ${rowIdAlias}`
  const primaryKey = primaryKeyColumns(table.columns)
  return primaryKey.length > 0
    ? `ORDER BY ${primaryKey.map(({ name }) => quoteIdentifier(name)).join(", ")}`
    : ""
}

function unshadowedRowIdAlias(columns: ReadonlyArray<DatabaseColumn>) {
  const names = new Set(columns.map(({ name }) => name.toLowerCase()))
  const alias = ROWID_ALIASES.find((candidate) => !names.has(candidate))
  if (!alias) {
    throw new DatabaseBrowserError(
      "read_only_table",
      "Every rowid alias is shadowed by a column, so rows cannot be addressed"
    )
  }
  return alias
}

export function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`)
}

export function encodeValue(value: unknown, blobLimit: number): DatabaseValue {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : { $bigint: value.toString() }
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) {
    const truncated = value.byteLength > blobLimit
    return {
      $blob: Buffer.from(
        truncated ? value.subarray(0, blobLimit) : value
      ).toString("base64"),
      size: value.byteLength,
      truncated,
    }
  }
  return String(value)
}

export function decodeValue(value: DatabaseValue) {
  if (value === null) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" || typeof value === "string") return value
  if ("$bigint" in value) return BigInt(value.$bigint)
  if (value.truncated) {
    throw new DatabaseBrowserError(
      "truncated_blob",
      "Truncated blob previews cannot be written back"
    )
  }
  return Buffer.from(value.$blob, "base64")
}

function isTruncatedBlob(value: DatabaseValue) {
  return typeof value === "object" && value !== null && "$blob" in value
    ? value.truncated
    : false
}

// node:sqlite prepares only the first statement of a string, so scripts are
// split here. Quotes, comments, and trigger bodies keep their semicolons.
export function splitSqlStatements(sql: string) {
  const statements: Array<string> = []
  let start = 0
  let index = 0
  let words: Array<string> = []
  let word = ""

  const flushWord = () => {
    if (word) words.push(word.toUpperCase())
    word = ""
  }

  while (index < sql.length) {
    const character = sql[index]
    const next = sql[index + 1]
    if (character === "-" && next === "-") {
      flushWord()
      const end = sql.indexOf("\n", index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (character === "/" && next === "*") {
      flushWord()
      const end = sql.indexOf("*/", index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      flushWord()
      index = skipQuoted(sql, index, character)
      continue
    }
    if (character === "[") {
      flushWord()
      const end = sql.indexOf("]", index + 1)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (character === ";") {
      flushWord()
      const trigger =
        words[0] === "CREATE" && words.slice(1, 4).includes("TRIGGER")
      if (!trigger || words.at(-1) === "END") {
        const statement = sql.slice(start, index).trim()
        if (statement && words.length > 0) statements.push(statement)
        start = index + 1
        words = []
      }
      index += 1
      continue
    }
    if (/[\w$]/u.test(character ?? "")) {
      word += character
    } else {
      flushWord()
    }
    index += 1
  }
  flushWord()
  const tail = sql.slice(start).trim()
  if (tail && words.length > 0) statements.push(tail)
  return statements
}

function skipQuoted(sql: string, index: number, quote: string) {
  let cursor = index + 1
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2
        continue
      }
      return cursor + 1
    }
    cursor += 1
  }
  return sql.length
}
