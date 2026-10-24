import { createHash } from "node:crypto"
import { PassThrough, type Readable } from "node:stream"

import { Cause, Effect, Stream } from "effect"
import {
  createConnection,
  escape,
  escapeId,
  type Connection,
  type SqlValue,
  type TypeCast,
} from "mysql2"

import { KilnDatabaseError } from "@/effect/errors"
import { forkPromise } from "@/effect/promise"
import { databaseConnectionConfig, databaseTable } from "@/lib/database-config"

// Hearth's own database as a SQL file, read and written through Hearth's own
// login. The file recreates every table from one consistent snapshot, so the
// mysql client can load it into an empty database; importing it here puts
// its rows back into the tables Hearth has.

/** An import is read whole and held in one transaction. */
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
      const schema = yield* schemaVersion(connection, "export")
      // The last line seals the file: a digest of everything before it.
      const digest = createHash("sha256")
      return Stream.make(dumpHeader(createdAt, schema)).pipe(
        Stream.concat(
          Stream.fromIterable(tables).pipe(
            Stream.flatMap((table) => tableStream(connection, table))
          )
        ),
        Stream.concat(Stream.make(DUMP_FOOTER)),
        Stream.tap((chunk) => Effect.sync(() => digest.update(chunk, "utf8"))),
        Stream.concat(
          Stream.suspend(() =>
            Stream.make(`${DUMP_SEAL}${digest.digest("hex")}\n`)
          )
        )
      )
    })
  )
}

// An import puts back the rows an export holds in one transaction: every
// table is emptied and refilled together or, if anything fails, left as it
// was, and requests meanwhile wait on its locks. It takes only a whole export
// from this same schema, so the tables already have the export's shape and
// it runs no DDL, which MySQL can't roll back; and only with a Kiln backup
// from the last day to come back to.
const RECENT_BACKUP_MS = 24 * 60 * 60_000

// As the export's header sets, except that unique keys stay checked and the
// server's strict mode stays on.
const IMPORT_SESSION = [
  // Next-key locks keep other writers out of the tables it empties, whatever
  // the server's default.
  "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  "SET NAMES utf8mb4",
  "SET time_zone = '+00:00'",
  "SET FOREIGN_KEY_CHECKS = 0",
  "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'NO_AUTO_VALUE_ON_ZERO')",
]

/** Puts a Kiln export's rows back into Hearth's database. */
export const importKilnDatabaseSql = Effect.fn("kilnDatabase.import")(
  function* (sql: string, kiln: { installationId: string; now: number }) {
    if (Buffer.byteLength(sql) > KILN_DATABASE_IMPORT_LIMIT_BYTES) {
      return yield* importRefused("too_large", "SQL files are limited to 32 MB")
    }
    const connection = yield* openConnection("import", {
      multipleStatements: false,
    })
    const plan = yield* checkKilnImport(connection, sql, kiln)
    for (const statement of IMPORT_SESSION) {
      yield* run(connection, "import", statement)
    }
    yield* run(connection, "import", "START TRANSACTION")
    yield* Effect.gen(function* () {
      for (const table of plan.tables) {
        yield* run(connection, "import", `DELETE FROM ${escapeId(table)}`)
      }
      for (const insert of plan.inserts) {
        yield* run(connection, "import", insert)
      }
      yield* run(connection, "import", "COMMIT")
    }).pipe(
      Effect.onError(() => Effect.ignore(run(connection, "import", "ROLLBACK")))
    )
  },
  Effect.scoped
)

interface ImportPlan {
  inserts: ReadonlyArray<string>
  tables: ReadonlyArray<string>
}

// The tables an export creates and its INSERTs, each a statement of its own,
// or null for any line an export doesn't write. Values are escaped onto one
// line each (`escape` writes newlines as \\n), so an INSERT is its first line
// and the row lines after it, up to the one ending its statement.
function parseKilnExport(sql: string): ImportPlan | null {
  const tables: Array<string> = []
  const inserts: Array<string> = []
  const lines = sql.split("\n")
  let index = 0
  const next = () => lines[index++]
  while (index < lines.length) {
    const line = next() ?? ""
    if (
      line === "" ||
      line.startsWith("-- ") ||
      /^SET [^;]*;$/u.test(line) ||
      /^DROP TABLE IF EXISTS `(?:[^`]|``)+`;$/u.test(line)
    ) {
      continue
    }
    const created = /^CREATE TABLE `((?:[^`]|``)+)` \($/u.exec(line)
    if (created?.[1]) {
      // Its definition runs to the line closing it.
      let closed = false
      while (index < lines.length && !closed) {
        const definition = next() ?? ""
        closed = definition.startsWith(")") && definition.endsWith(";")
      }
      if (!closed) return null
      tables.push(created[1].replaceAll("``", "`"))
      continue
    }
    const target = /^INSERT INTO `((?:[^`]|``)+)` \(.*\) VALUES$/u.exec(line)
    if (!target?.[1] || !tables.includes(target[1].replaceAll("``", "`"))) {
      return null
    }
    const statement = [line]
    let ended = false
    while (index < lines.length && !ended) {
      const row = next() ?? ""
      if (!row.startsWith("(")) return null
      ended = row.endsWith(");")
      if (!ended && !row.endsWith("),")) return null
      statement.push(ended ? row.slice(0, -1) : row)
    }
    if (!ended) return null
    inserts.push(statement.join("\n"))
  }
  return { inserts, tables }
}

// The file as Kiln wrote it: whole, and unchanged since.
function sealedExport(sql: string): boolean {
  const body = sql.endsWith("\n") ? sql.slice(0, -1) : sql
  const lastLine = body.lastIndexOf("\n") + 1
  const seal = body.slice(lastLine)
  return (
    seal.startsWith(DUMP_SEAL) &&
    seal.slice(DUMP_SEAL.length) ===
      createHash("sha256").update(body.slice(0, lastLine), "utf8").digest("hex")
  )
}

const checkKilnImport = Effect.fnUntraced(function* (
  connection: Connection,
  sql: string,
  kiln: { installationId: string; now: number }
) {
  if (!sql.startsWith(`${DUMP_TITLE}\n`)) {
    return yield* importRefused(
      "not_kiln_export",
      "Import a SQL file exported from Kiln's Data section"
    )
  }
  if (!sealedExport(sql)) {
    return yield* importRefused(
      "changed",
      "This export is incomplete or was changed; export Kiln's database again"
    )
  }
  const plan = parseKilnExport(sql)
  if (!plan) {
    return yield* importRefused(
      "changed",
      "This export holds something Kiln doesn't write; export Kiln's database again"
    )
  }
  const exported = Number(/^-- Kiln schema (\d+)$/mu.exec(sql)?.[1] ?? NaN)
  const current = yield* schemaVersion(connection, "import")
  const tables = (yield* listTables(connection)).map((table) => table.name)
  if (
    exported !== current ||
    tables.length !== plan.tables.length ||
    tables.some((table) => !plan.tables.includes(table))
  ) {
    return yield* importRefused(
      "other_schema",
      Number.isNaN(exported)
        ? "This export doesn't say which version of Kiln made it"
        : `This export is from schema ${exported}, and Hearth runs schema ${current}. Import an export from this version of Kiln.`
    )
  }
  const [backup] = yield* query<Array<{ id: string }>>(
    connection,
    "import",
    `SELECT id FROM ${databaseTable("backup")}
      WHERE target_kind = 'platform' AND target_id = ${escape(kiln.installationId)}
        AND status = 'available' AND created_at >= ${escape(kiln.now - RECENT_BACKUP_MS)}
      LIMIT 1`
  )
  if (!backup) {
    return yield* importRefused(
      "no_recent_backup",
      "Back Kiln up first: importing needs a Kiln backup from the last day"
    )
  }
  return plan
})

// The newest migration applied, which names the tables' shape.
function schemaVersion(connection: Connection, operation: "export" | "import") {
  return Effect.map(
    query<Array<{ id: number | null }>>(
      connection,
      operation,
      `SELECT MAX(id) AS id FROM ${databaseTable("schema_migration")}`
    ),
    ([row]) => Number(row?.id ?? 0)
  )
}

function importRefused(
  refusal: NonNullable<KilnDatabaseError["refusal"]>,
  reason: string
) {
  return KilnDatabaseError.make({ operation: "import", reason, refusal })
}

const DUMP_TITLE = "-- Kiln database export"
const DUMP_SEAL = "-- Kiln export sha256 "

function dumpHeader(createdAt: Date, schema: number) {
  return [
    DUMP_TITLE,
    `-- Created ${createdAt.toISOString()}`,
    `-- Kiln schema ${schema}`,
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
  const rows = Stream.suspend(() => {
    const source = rowStream(
      connection,
      `SELECT ${table.columns.map((column) => escapeId(column)).join(", ")} FROM ${escapeId(table.name)}`
    )
    const statements = insertStatements(table, source)[Symbol.asyncIterator]()
    // Each statement as it's ready. Cancelling the export, as a download
    // that's closed does, destroys the rows at once, even while MySQL holds
    // the query, so the connection is let go.
    const next = Effect.callback<string, KilnDatabaseError | Cause.Done>(
      (resume) => {
        forkPromise(
          async () => {
            const step = await statements.next()
            resume(step.done ? Cause.done() : Effect.succeed(step.value))
          },
          (cause) =>
            resume(
              Effect.fail(
                KilnDatabaseError.make({
                  cause,
                  operation: "export",
                  reason: errorReason(cause),
                })
              )
            )
        )
        return Effect.sync(() => source.destroy())
      }
    )
    return Stream.fromEffectRepeat(next).pipe(
      Stream.ensuring(Effect.sync(() => source.destroy()))
    )
  })
  return Stream.fromEffect(definition).pipe(Stream.concat(rows))
}

// Connections that were lost, with why: an error between queries reaches
// only the connection's listener, and mysql2 goes on writing later queries
// to the closed socket without ever answering them.
const lostConnections = new WeakMap<Connection, Error>()

// A table's rows as they arrive. mysql2 reports a lost connection on the
// connection rather than the stream, which would then wait forever, so the
// stream ends with that error: one lost earlier, one raised as the query is
// sent, or one while its rows arrive.
function rowStream(connection: Connection, sql: string) {
  let rows: (Readable & AsyncIterable<ReadonlyArray<SqlValue>>) | null = null
  let failure = lostConnections.get(connection) ?? null
  const lost = (error: Error) => {
    failure ??= error
    rows?.destroy(error)
  }
  connection.on("error", lost)
  rows = (
    failure
      ? new PassThrough({ objectMode: true })
      : connection
          .query({ rowsAsArray: true, sql, typeCast: dumpTypeCast })
          .stream()
  ) as Readable & AsyncIterable<ReadonlyArray<SqlValue>>
  rows.once("close", () => connection.off("error", lost))
  // The reader sees an error through its iterator, which the stream keeps;
  // this keeps one raised before reading starts from going unhandled.
  rows.on("error", () => {})
  if (failure) rows.destroy(failure)
  return rows
}

// A table's rows as multi-row INSERTs, then a blank line.
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
// columns are left to MySQL to compute again. A column with a default from
// an expression (DEFAULT_GENERATED) keeps its own values.
const listTables = Effect.fnUntraced(function* (connection: Connection) {
  const rows = yield* query<Array<{ column: string | null; name: string }>>(
    connection,
    "export",
    `SELECT tables.TABLE_NAME AS name, columns.COLUMN_NAME AS \`column\`
       FROM information_schema.TABLES tables
       LEFT JOIN information_schema.COLUMNS columns
         ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA
        AND columns.TABLE_NAME = tables.TABLE_NAME
        AND columns.EXTRA NOT LIKE '%VIRTUAL GENERATED%'
        AND columns.EXTRA NOT LIKE '%STORED GENERATED%'
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
      // A connection lost between queries would otherwise throw from the
      // socket and take Hearth down. A query then fails on its own, and a
      // row stream is ended with the error (see `rowStream`).
      connection.on("error", (error) => {
        lostConnections.set(connection, error)
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
    // A query on a connection the server closed is written to a dead socket
    // and never answered, so a lost connection fails it here.
    const lost = lostConnections.get(connection)
    if (lost) {
      resume(
        Effect.fail(
          KilnDatabaseError.make({
            cause: lost,
            operation,
            reason: errorReason(lost),
          })
        )
      )
      return
    }
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
