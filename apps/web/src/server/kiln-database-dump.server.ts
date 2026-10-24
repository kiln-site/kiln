import type { Readable } from "node:stream"

import { Effect, Stream } from "effect"
import {
  createConnection,
  escape,
  escapeId,
  type Connection,
  type SqlValue,
  type TypeCast,
} from "mysql2"

import { KilnDatabaseError } from "@/effect/errors"
import { databaseConnectionConfig } from "@/lib/database-config"

// Hearth's own database as a SQL file, read and written through Hearth's own
// login. The file recreates every table from one consistent snapshot, so
// importing it replaces each table it holds.

/** Imports run as one statement batch, which MySQL caps at 64 MB by default. */
export const KILN_DATABASE_IMPORT_LIMIT_BYTES = 32 * 1024 * 1024

// Rows are written in multi-row INSERTs of about this many characters.
const INSERT_BATCH_CHARACTERS = 512 * 1024

// Values come back as MySQL wrote them, so they go back unchanged: dates and
// big numbers as text, JSON as its text rather than parsed, and binary values
// as bytes, which `escape` writes as hex.
const dumpTypeCast: TypeCast = (field, next) =>
  field.type === "JSON"
    ? field.string("utf8")
    : field.type === "GEOMETRY"
      ? field.buffer()
      : next()

interface DumpTable {
  columns: ReadonlyArray<string>
  name: string
}

/** Every table's definition and rows, as SQL. */
export function kilnDatabaseDump(
  createdAt: Date
): Stream.Stream<string, KilnDatabaseError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const connection = yield* openConnection("export", {
        multipleStatements: false,
      })
      // Every table from the same moment, without locking Hearth out.
      yield* run(connection, "export", "SET time_zone = '+00:00'")
      yield* run(
        connection,
        "export",
        "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"
      )
      yield* run(
        connection,
        "export",
        "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY"
      )
      const tables = yield* listTables(connection)
      return Stream.make(dumpHeader(createdAt)).pipe(
        Stream.concat(
          Stream.fromIterable(tables).pipe(
            Stream.flatMap((table) => tableStream(connection, table))
          )
        ),
        Stream.concat(Stream.make(DUMP_FOOTER))
      )
    })
  )
}

/** Runs a SQL file against Hearth's database, as one batch. */
export const importKilnDatabaseSql = Effect.fn("kilnDatabase.import")(
  function* (sql: string) {
    if (Buffer.byteLength(sql) > KILN_DATABASE_IMPORT_LIMIT_BYTES) {
      return yield* KilnDatabaseError.make({
        operation: "import",
        reason: "SQL files are limited to 32 MB",
      })
    }
    const connection = yield* openConnection("import", {
      multipleStatements: true,
    })
    yield* run(connection, "import", sql)
  },
  Effect.scoped
)

function dumpHeader(createdAt: Date) {
  return [
    "-- Kiln database export",
    `-- Created ${createdAt.toISOString()}`,
    "",
    "SET NAMES utf8mb4;",
    "SET time_zone = '+00:00';",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "SET UNIQUE_CHECKS = 0;",
    "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    "",
    "",
  ].join("\n")
}

const DUMP_FOOTER = [
  "SET FOREIGN_KEY_CHECKS = 1;",
  "SET UNIQUE_CHECKS = 1;",
  "",
].join("\n")

function tableStream(
  connection: Connection,
  table: DumpTable
): Stream.Stream<string, KilnDatabaseError> {
  const definition = Effect.map(
    query<Array<{ "Create Table": string }>>(
      connection,
      "export",
      `SHOW CREATE TABLE ${escapeId(table.name)}`
    ),
    ([row]) =>
      `DROP TABLE IF EXISTS ${escapeId(table.name)};\n${row?.["Create Table"] ?? ""};\n\n`
  )
  if (table.columns.length === 0) return Stream.fromEffect(definition)
  // Queued only once the definition is written: the connection answers one
  // query at a time, and a row stream holds it until it's read.
  const rows = Stream.suspend(() =>
    Stream.fromAsyncIterable(
      insertStatements(
        table,
        connection
          .query({
            rowsAsArray: true,
            sql: `SELECT ${table.columns.map((column) => escapeId(column)).join(", ")} FROM ${escapeId(table.name)}`,
            typeCast: dumpTypeCast,
          })
          .stream() as Readable & AsyncIterable<ReadonlyArray<SqlValue>>
      ),
      (cause) =>
        KilnDatabaseError.make({
          cause,
          operation: "export",
          reason: errorReason(cause),
        })
    )
  )
  return Stream.fromEffect(definition).pipe(Stream.concat(rows))
}

async function* insertStatements(
  table: DumpTable,
  rows: AsyncIterable<ReadonlyArray<SqlValue>>
): AsyncGenerator<string> {
  const prefix = `INSERT INTO ${escapeId(table.name)} (${table.columns
    .map((column) => escapeId(column))
    .join(", ")}) VALUES\n`
  let tuples: Array<string> = []
  let characters = 0
  for await (const row of rows) {
    const tuple = `(${row.map((value) => escape(value)).join(",")})`
    tuples.push(tuple)
    characters += tuple.length
    if (characters >= INSERT_BATCH_CHARACTERS) {
      yield `${prefix}${tuples.join(",\n")};\n`
      tuples = []
      characters = 0
    }
  }
  if (tuples.length > 0) yield `${prefix}${tuples.join(",\n")};\n`
  yield "\n"
}

// Base tables in name order, each with the columns it stores; generated
// columns are left to MySQL to compute again.
const listTables = Effect.fnUntraced(function* (connection: Connection) {
  const rows = yield* query<Array<{ column: string | null; name: string }>>(
    connection,
    "export",
    `SELECT tables.TABLE_NAME AS name, columns.COLUMN_NAME AS \`column\`
       FROM information_schema.TABLES tables
       LEFT JOIN information_schema.COLUMNS columns
         ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
        AND columns.TABLE_NAME = tables.TABLE_NAME
        AND columns.EXTRA NOT LIKE '%GENERATED%'
      WHERE tables.TABLE_SCHEMA = DATABASE()
        AND tables.TABLE_TYPE = 'BASE TABLE'
      ORDER BY tables.TABLE_NAME, columns.ORDINAL_POSITION`
  )
  const tables = new Map<string, Array<string>>()
  for (const row of rows) {
    const columns = tables.get(row.name) ?? []
    if (row.column !== null) columns.push(row.column)
    tables.set(row.name, columns)
  }
  return [...tables].map(([name, columns]): DumpTable => ({ columns, name }))
})

function openConnection(
  operation: "export" | "import",
  options: { multipleStatements: boolean }
) {
  const config = databaseConnectionConfig()
  return Effect.acquireRelease(
    Effect.callback<Connection, KilnDatabaseError>((resume) => {
      const connection = createConnection({
        bigNumberStrings: true,
        charset: "utf8mb4",
        connectTimeout: 10_000,
        database: config.database,
        dateStrings: true,
        host: config.host,
        multipleStatements: options.multipleStatements,
        password: config.password,
        port: config.port,
        supportBigNumbers: true,
        timezone: "Z",
        user: config.user,
      })
      connection.connect((error) => {
        resume(
          error
            ? Effect.fail(
                KilnDatabaseError.make({
                  cause: error,
                  operation,
                  reason: errorReason(error),
                })
              )
            : Effect.succeed(connection)
        )
      })
    }),
    (connection) =>
      Effect.callback<void>((resume) => {
        connection.end(() => resume(Effect.void))
      }).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.sync(() => connection.destroy()),
        })
      )
  )
}

function query<TRows>(
  connection: Connection,
  operation: "export" | "import",
  sql: string
) {
  return Effect.callback<TRows, KilnDatabaseError>((resume) => {
    connection.query(sql, (error, rows) => {
      resume(
        error
          ? Effect.fail(
              KilnDatabaseError.make({
                cause: error,
                operation,
                reason: errorReason(error),
              })
            )
          : Effect.succeed(rows as TRows)
      )
    })
  })
}

function run(
  connection: Connection,
  operation: "export" | "import",
  sql: string
) {
  return Effect.asVoid(query<unknown>(connection, operation, sql))
}

function errorReason(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "MySQL didn't answer"
}
