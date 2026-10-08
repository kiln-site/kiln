import { type ChildProcess, spawn } from "node:child_process"
import { Duplex } from "node:stream"

import type {
  DatabaseChange,
  DatabaseColumn,
  DatabaseConflict,
  DatabaseMutateInput,
  DatabaseMutateResult,
  DatabaseOverview,
  DatabaseQueryInput,
  DatabaseQueryResult,
  DatabaseReadRequest,
  DatabaseResultColumn,
  DatabaseRowKey,
  DatabaseRows,
  DatabaseRowsInput,
  DatabaseTable,
  DatabaseValue,
  DatabaseWriteRequest,
  RelayManagedDatabase,
} from "@workspace/contracts"
import { databaseEngineSupportsBrowsing } from "@workspace/contracts"
import { Effect } from "effect"
import mysql from "mysql2"
import pg from "pg"

import { RelayDatabaseBrowserError } from "./effect/errors.js"

// Managed databases sit on internal Docker networks the Relay is not part of,
// so the drivers talk to them through a byte pipe opened inside the database
// container. The drivers still speak their real protocols, which keeps
// values, parameters, and transactions exact.

const OPERATION_TIMEOUT = "25 seconds"
const STATEMENT_TIMEOUT_MS = 20_000
// Counting stops here so huge tables stay fast; results say when it was hit.
const COUNT_CAP = 100_000
const BLOB_PREVIEW_BYTES = 1_024

type BrowsableEngine = "mariadb" | "mysql" | "postgres"

export interface ManagedDatabaseCredentials {
  password: string
  username: string
}

export interface BrowseAccess {
  // Granted write access: editing rows and running SQL.
  canWrite: boolean
  // Run SQL in a read-only transaction anyway.
  readOnly: boolean
}

export function browseManagedDatabase(
  database: RelayManagedDatabase,
  credentials: ManagedDatabaseCredentials,
  request: DatabaseReadRequest | DatabaseWriteRequest,
  access: BrowseAccess
) {
  const engine = database.engine
  const container = database.containerId
  if (!databaseEngineSupportsBrowsing(engine)) {
    return Effect.fail(
      browserError(
        "unsupported_engine",
        "This database engine can't be browsed as tables"
      )
    )
  }
  if (!container || database.observedState !== "running") {
    return Effect.fail(
      browserError("not_running", "Start the database to browse its tables")
    )
  }
  const target = {
    container,
    databaseName: database.databaseName,
    port: database.internalPort,
    ...credentials,
  }
  return Effect.acquireUseRelease(
    attempt("connect", (): Promise<SqlSession> =>
      engine === "postgres"
        ? PostgresSession.open(target)
        : MysqlSession.open(target, engine, request.action === "query")
    ),
    (session) =>
      attempt(request.action, () => runRequest(session, request, access)),
    (session) => Effect.promise(() => session.close())
  ).pipe(
    Effect.timeoutOrElse({
      duration: OPERATION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          browserError(
            "timeout",
            `This took longer than ${OPERATION_TIMEOUT}, so it was stopped.`
          )
        ),
    }),
    Effect.withSpan(`relay.databases.browse.${request.action}`, {
      attributes: { "kiln.database.engine": engine },
    })
  )
}

async function runRequest(
  session: SqlSession,
  request: DatabaseReadRequest | DatabaseWriteRequest,
  access: BrowseAccess
): Promise<unknown> {
  switch (request.action) {
    case "overview":
      return overview(session)
    case "rows":
      return rows(session, request)
    case "query":
      // A read-only transaction can't contain arbitrary SQL (functions,
      // COPY, or a COMMIT inside the script), so SQL needs write access.
      if (!access.canWrite) {
        throw browserError("read_only", "Running SQL needs write access")
      }
      return query(session, request, !access.readOnly)
    case "mutate":
      if (!access.canWrite) {
        throw browserError("read_only", "Editing rows needs write access")
      }
      return mutate(session, request)
  }
}

// --- Sessions ---------------------------------------------------------------

interface SqlResult {
  changes: number | null
  columns: Array<DatabaseResultColumn>
  rows: Array<Array<DatabaseValue>>
  truncated: boolean
}

interface SqlSession {
  readonly dialect: Dialect
  close(): Promise<void>
  // One statement with parameters. Values come back encoded for the browser.
  execute(sql: string, parameters?: ReadonlyArray<unknown>): Promise<SqlResult>
  // A user script that may hold several statements; the last result wins.
  script(sql: string, maxRows: number): Promise<SqlResult>
}

interface SessionTarget extends ManagedDatabaseCredentials {
  container: string
  databaseName: string
  port: number
}

class PostgresSession implements SqlSession {
  readonly dialect = postgresDialect
  readonly #client: pg.Client
  readonly #typeNames = new Map<number, string>()

  private constructor(client: pg.Client) {
    this.#client = client
  }

  static async open(target: SessionTarget) {
    const client = new pg.Client({
      database: target.databaseName,
      host: "127.0.0.1",
      password: target.password,
      port: target.port,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      stream: () => new ContainerSocket(target.container, target.port),
      // Every value arrives as Postgres text; columns decode by type below.
      types: { getTypeParser: () => (value: string) => value },
      user: target.username,
    })
    await client.connect()
    return new PostgresSession(client)
  }

  async close() {
    await this.#client.end().catch(() => undefined)
  }

  async execute(sql: string, parameters: ReadonlyArray<unknown> = []) {
    const result = await this.#client.query({
      rowMode: "array",
      text: sql,
      values: [...parameters],
    })
    return this.#encode(result.fields, result.rows, result.rowCount)
  }

  async script(sql: string, maxRows: number) {
    // The simple protocol runs every statement and keeps only `maxRows` rows
    // of the last result set in memory.
    const submitted = new pg.Query({
      rowMode: "array",
      text: sql,
    } as pg.QueryConfig)
    let fields: Array<pg.FieldDef> = []
    let kept: Array<Array<unknown>> = []
    let truncated = false
    let changes: number | null = null
    let current: unknown = null
    submitted.on("row", (row: Array<unknown>, result) => {
      if (result !== current) {
        current = result
        fields = result?.fields ?? []
        kept = []
        truncated = false
      }
      if (kept.length < maxRows) kept.push(row)
      else truncated = true
    })
    const results = await new Promise<Array<pg.QueryResult>>(
      (resolve, reject) => {
        submitted.on("error", reject)
        submitted.on("end", (result: pg.QueryResult | Array<pg.QueryResult>) =>
          resolve(Array.isArray(result) ? result : [result])
        )
        this.#client.query(submitted)
      }
    )
    for (const result of results) {
      if (result.fields.length === 0 && result.rowCount !== null) {
        changes = (changes ?? 0) + result.rowCount
      }
    }
    const last = results.at(-1)
    if (!last || last.fields.length === 0 || last !== current) {
      return { changes, columns: [], rows: [], truncated: false }
    }
    const encoded = await this.#encode(fields, kept, last.rowCount)
    return { ...encoded, changes, truncated }
  }

  async #encode(
    fields: ReadonlyArray<pg.FieldDef>,
    rows: ReadonlyArray<Array<unknown>>,
    rowCount: number | null
  ): Promise<SqlResult> {
    await this.#loadTypeNames(fields.map(({ dataTypeID }) => dataTypeID))
    return {
      changes: fields.length === 0 ? rowCount : null,
      columns: fields.map(({ dataTypeID, name }) => ({
        name,
        type: this.#typeNames.get(dataTypeID) ?? null,
      })),
      rows: rows.map((row) =>
        row.map((value, index) =>
          decodePostgresText(
            value as string | null,
            fields[index]?.dataTypeID ?? 0
          )
        )
      ),
      truncated: false,
    }
  }

  async #loadTypeNames(oids: ReadonlyArray<number>) {
    const missing = [...new Set(oids)].filter(
      (oid) => !this.#typeNames.has(oid)
    )
    if (missing.length === 0) return
    const result = await this.#client.query({
      rowMode: "array",
      text: "SELECT oid::int, format_type(oid, NULL) FROM pg_type WHERE oid = ANY($1::oid[])",
      values: [missing],
    })
    for (const [oid, name] of result.rows as Array<[string, string]>) {
      this.#typeNames.set(Number(oid), name)
    }
  }
}

class MysqlSession implements SqlSession {
  readonly dialect: Dialect
  readonly #connection: mysql.Connection

  private constructor(connection: mysql.Connection, engine: BrowsableEngine) {
    this.#connection = connection
    this.dialect = engine === "mariadb" ? mariadbDialect : mysqlDialect
  }

  static async open(
    target: SessionTarget,
    engine: BrowsableEngine,
    multipleStatements: boolean
  ) {
    const connection = mysql.createConnection({
      charset: "utf8mb4",
      database: target.databaseName,
      multipleStatements,
      password: target.password,
      stream: () => new ContainerSocket(target.container, target.port),
      supportBigNumbers: true,
      user: target.username,
    })
    await new Promise<void>((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve()))
    )
    const session = new MysqlSession(connection, engine)
    await session.execute(
      engine === "mariadb"
        ? `SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_MS / 1_000}`
        : `SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`
    )
    return session
  }

  async close() {
    await new Promise<void>((resolve) =>
      this.#connection.end(() => resolve())
    ).catch(() => undefined)
    this.#connection.destroy()
  }

  async execute(sql: string, parameters: ReadonlyArray<unknown> = []) {
    const [result, fields] = await new Promise<
      [unknown, Array<mysql.FieldPacket> | undefined]
    >((resolve, reject) =>
      this.#connection.query(
        { rowsAsArray: true, sql, typeCast: false, values: [...parameters] },
        (error, result, fields) =>
          error ? reject(error) : resolve([result, fields])
      )
    )
    if (!fields) {
      return {
        changes: (result as mysql.ResultSetHeader).affectedRows,
        columns: [],
        rows: [],
        truncated: false,
      }
    }
    return {
      changes: null,
      columns: fields.map(mysqlResultColumn),
      rows: (result as Array<Array<Buffer | null>>).map((row) =>
        row.map((value, index) => decodeMysqlValue(value, fields[index]))
      ),
      truncated: false,
    }
  }

  async script(sql: string, maxRows: number) {
    let fields: Array<mysql.FieldPacket> | null = null
    let kept: Array<Array<Buffer | null>> = []
    let truncated = false
    let changes: number | null = null
    await new Promise<void>((resolve, reject) => {
      const submitted = this.#connection.query({
        rowsAsArray: true,
        sql,
        typeCast: false,
      })
      submitted.on("error", reject)
      // mysql2 announces every statement's columns, or undefined for a
      // statement without rows, before its rows or its OK packet.
      submitted.on("fields", (next?: Array<mysql.FieldPacket>) => {
        fields = next ?? null
        kept = []
        truncated = false
      })
      submitted.on("result", (row: unknown, index?: number) => {
        if (index === undefined) {
          const header = row as mysql.ResultSetHeader | null
          changes = (changes ?? 0) + (header?.affectedRows ?? 0)
          return
        }
        if (kept.length < maxRows) kept.push(row as Array<Buffer | null>)
        else truncated = true
      })
      submitted.on("end", () => resolve())
    })
    // Assigned in the listeners above, which TypeScript doesn't follow.
    const columns = fields as Array<mysql.FieldPacket> | null
    if (!columns) return { changes, columns: [], rows: [], truncated: false }
    return {
      changes,
      columns: columns.map(mysqlResultColumn),
      rows: kept.map((row) =>
        row.map((value, index) => decodeMysqlValue(value, columns[index]))
      ),
      truncated,
    }
  }
}

// A Duplex that pg and mysql2 use in place of a TCP socket. Inside the
// database container, bash connects to the engine on loopback and copies
// bytes both ways over `docker exec`'s stdio.
class ContainerSocket extends Duplex {
  readonly #container: string
  readonly #port: number
  #child: ChildProcess | null = null
  #stderr = ""

  constructor(container: string, port: number) {
    super()
    this.#container = container
    this.#port = port
    // mysql2 never calls connect(); pg calls it once with its own arguments.
    queueMicrotask(() => this.connect())
  }

  connect() {
    if (this.#child) return this
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        this.#container,
        "bash",
        "-c",
        'exec 3<>"/dev/tcp/127.0.0.1/$0" || exit 1; cat <&3 & exec cat >&3',
        String(this.#port),
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    )
    this.#child = child
    child.once("spawn", () => this.emit("connect"))
    child.once("error", (error) => this.destroy(error))
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout?.pause()
    })
    child.stdout?.once("end", () => this.push(null))
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-2_000)
    })
    child.once("exit", (code) => {
      if (code && code !== 0 && !this.destroyed) {
        this.destroy(
          new Error(
            this.#stderr.trim() ||
              `The database connection closed with code ${code}`
          )
        )
      }
    })
    return this
  }

  override _read() {
    this.#child?.stdout?.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    const stdin = this.#child?.stdin
    if (!stdin) {
      callback(new Error("The database connection is not open"))
      return
    }
    stdin.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void) {
    this.#child?.stdin?.end()
    callback()
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ) {
    this.#child?.stdin?.destroy()
    this.#child?.kill()
    callback(error)
  }

  setNoDelay() {
    return this
  }

  setKeepAlive() {
    return this
  }

  setTimeout() {
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

// --- Dialects ---------------------------------------------------------------

interface Dialect {
  engine: BrowsableEngine
  quote(name: string): string
  placeholder(index: number): string
  // Matches a column's text form against a LIKE pattern, case-insensitively.
  searchCondition(column: string, placeholder: string): string
  begin(readOnly: boolean): string
}

const postgresDialect: Dialect = {
  engine: "postgres",
  quote: (name) => `"${name.replaceAll('"', '""')}"`,
  placeholder: (index) => `$${index}`,
  searchCondition: (column, placeholder) =>
    `${column}::text ILIKE ${placeholder}`,
  begin: (readOnly) => (readOnly ? "BEGIN READ ONLY" : "BEGIN"),
}

const mysqlDialect: Dialect = {
  engine: "mysql",
  quote: (name) => `\`${name.replaceAll("`", "``")}\``,
  placeholder: () => "?",
  searchCondition: (column, placeholder) =>
    `CAST(${column} AS CHAR) LIKE ${placeholder}`,
  begin: (readOnly) =>
    readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION",
}

const mariadbDialect: Dialect = { ...mysqlDialect, engine: "mariadb" }

// Tables outside the default schema are named "schema.table"; the catalog
// keeps the real parts so names are never parsed back.
interface CatalogTable extends DatabaseTable {
  schema: string
  table: string
}

function qualifiedName(dialect: Dialect, table: CatalogTable) {
  return `${dialect.quote(table.schema)}.${dialect.quote(table.table)}`
}

// --- Overview ---------------------------------------------------------------

async function overview(session: SqlSession): Promise<DatabaseOverview> {
  const [tables, meta] = await Promise.all([
    listTables(session),
    session.execute(
      session.dialect.engine === "postgres"
        ? "SELECT current_setting('server_version'), pg_database_size(current_database())"
        : "SELECT VERSION(), (SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())"
    ),
  ])
  const [version, size] = meta.rows[0] ?? []
  return {
    engine: session.dialect.engine,
    engineVersion: String(version ?? ""),
    modifiedAt: null,
    readOnly: false,
    sizeBytes: Math.max(0, Math.trunc(Number(numberValue(size) ?? 0))),
    tables: tables.map(({ schema: _schema, table: _table, ...table }) => table),
  }
}

async function listTables(session: SqlSession): Promise<Array<CatalogTable>> {
  return session.dialect.engine === "postgres"
    ? listPostgresTables(session)
    : listMysqlTables(session)
}

async function listPostgresTables(session: SqlSession) {
  // Sequential: one connection runs one statement at a time.
  const relations = await session.execute(
    `SELECT c.oid::int, n.nspname, c.relname, c.relkind,
            CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        AND has_table_privilege(c.oid, 'SELECT')
      ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname`
  )
  const oids = relations.rows.map(([oid]) => Number(oid))
  if (oids.length === 0) return []
  const columns = await session.execute(
    `SELECT a.attrelid::int, a.attname, format_type(a.atttypid, a.atttypmod),
            a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
            a.attgenerated <> '' OR a.attidentity = 'a',
            COALESCE(array_position(con.conkey, a.attnum), 0)
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_constraint con
              ON con.conrelid = a.attrelid AND con.contype = 'p'
      WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
    [oids]
  )
  const byRelation = new Map<number, Array<DatabaseColumn>>()
  for (const [
    relation,
    name,
    type,
    notNull,
    defaultValue,
    generated,
    pk,
  ] of columns.rows) {
    const list = byRelation.get(Number(relation)) ?? []
    list.push({
      defaultValue: typeof defaultValue === "string" ? defaultValue : null,
      generated: generated === true,
      name: String(name),
      nullable: notNull !== true,
      primaryKey: Number(pk ?? 0),
      type: String(type),
    })
    byRelation.set(Number(relation), list)
  }
  return relations.rows.map(([oid, schema, table, kind, definition]) => {
    const tableColumns = byRelation.get(Number(oid)) ?? []
    const isTable = kind === "r" || kind === "p" || kind === "f"
    return {
      columns: tableColumns,
      kind: isTable ? ("table" as const) : ("view" as const),
      name: schema === "public" ? String(table) : `${schema}.${table}`,
      rowIdentity:
        isTable && tableColumns.some(({ primaryKey }) => primaryKey > 0)
          ? ("primary-key" as const)
          : null,
      schema: String(schema),
      sql: typeof definition === "string" ? definition.trim() : null,
      table: String(table),
    }
  })
}

async function listMysqlTables(session: SqlSession) {
  const relations = await session.execute(
    `SELECT t.TABLE_NAME, t.TABLE_TYPE, v.VIEW_DEFINITION
       FROM information_schema.TABLES t
       LEFT JOIN information_schema.VIEWS v
              ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = DATABASE()
      ORDER BY t.TABLE_NAME`
  )
  const columns = await session.execute(
    `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE,
            c.COLUMN_DEFAULT, c.EXTRA, COALESCE(k.ORDINAL_POSITION, 0)
       FROM information_schema.COLUMNS c
       LEFT JOIN information_schema.KEY_COLUMN_USAGE k
              ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
             AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'
      WHERE c.TABLE_SCHEMA = DATABASE()
      ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
  )
  const schema = await session.execute("SELECT DATABASE()")
  const databaseName = String(schema.rows[0]?.[0] ?? "")
  const byTable = new Map<string, Array<DatabaseColumn>>()
  for (const [
    table,
    name,
    type,
    nullable,
    defaultValue,
    extra,
    pk,
  ] of columns.rows) {
    const list = byTable.get(String(table)) ?? []
    list.push({
      defaultValue: typeof defaultValue === "string" ? defaultValue : null,
      generated: /\bGENERATED\b/iu.test(String(extra ?? "")),
      name: String(name),
      nullable: nullable === "YES",
      primaryKey: Number(numberValue(pk) ?? 0),
      type: String(type),
    })
    byTable.set(String(table), list)
  }
  return relations.rows.map(([table, type, definition]) => {
    const tableColumns = byTable.get(String(table)) ?? []
    const isTable = type === "BASE TABLE"
    return {
      columns: tableColumns,
      kind: isTable ? ("table" as const) : ("view" as const),
      name: String(table),
      rowIdentity:
        isTable && tableColumns.some(({ primaryKey }) => primaryKey > 0)
          ? ("primary-key" as const)
          : null,
      schema: databaseName,
      sql: typeof definition === "string" ? definition : null,
      table: String(table),
    }
  })
}

async function requireTable(session: SqlSession, name: string) {
  const table = (await listTables(session)).find((entry) => entry.name === name)
  if (!table) throw browserError("unknown_table", `Unknown table ${name}`)
  return table
}

// --- Rows -------------------------------------------------------------------

async function rows(
  session: SqlSession,
  input: DatabaseRowsInput
): Promise<DatabaseRows> {
  const { dialect } = session
  const table = await requireTable(session, input.table)
  const columns = table.columns
  if (input.sort && !columns.some(({ name }) => name === input.sort?.column)) {
    throw browserError("unknown_column", `Unknown column ${input.sort.column}`)
  }
  const search = input.search?.trim()
  const searchParameters =
    search && columns.length > 0
      ? columns.map(() => `%${escapeLike(search)}%`)
      : []
  const where =
    searchParameters.length > 0
      ? `WHERE ${columns
          .map(({ name }, index) =>
            dialect.searchCondition(
              dialect.quote(name),
              dialect.placeholder(index + 1)
            )
          )
          .join(" OR ")}`
      : ""
  const primaryKey = primaryKeyColumns(columns)
  const order = input.sort
    ? `ORDER BY ${dialect.quote(input.sort.column)} ${input.sort.direction === "desc" ? "DESC" : "ASC"}`
    : primaryKey.length > 0
      ? `ORDER BY ${primaryKey.map(({ name }) => dialect.quote(name)).join(", ")}`
      : ""
  const from = `FROM ${qualifiedName(dialect, table)} ${where}`
  const next = searchParameters.length + 1

  // Sequential: one connection runs one statement at a time, and both
  // statements see the same table state inside one read-only transaction.
  await session.execute(dialect.begin(true))
  const page = await session.execute(
    `SELECT ${columns.map(({ name }) => dialect.quote(name)).join(", ") || "*"} ${from} ${order} LIMIT ${dialect.placeholder(next)} OFFSET ${dialect.placeholder(next + 1)}`,
    [...searchParameters, input.limit, input.offset]
  )
  const counted = await session.execute(
    `SELECT count(*) FROM (SELECT 1 ${from} LIMIT ${dialect.placeholder(next)}) counted`,
    [...searchParameters, COUNT_CAP + 1]
  )
  await session.execute("ROLLBACK")
  const total = Number(numberValue(counted.rows[0]?.[0]) ?? 0)

  return {
    columns: columns.map(({ name, type }) => ({ name, type: type || null })),
    keys:
      table.rowIdentity === "primary-key"
        ? page.rows.map((row) =>
            Object.fromEntries(
              primaryKey.map((column) => [
                column.name,
                row[columns.indexOf(column)] ?? null,
              ])
            )
          )
        : null,
    offset: input.offset,
    rows: page.rows,
    total: Math.min(total, COUNT_CAP),
    totalCapped: total > COUNT_CAP,
  }
}

// --- Query ------------------------------------------------------------------

async function query(
  session: SqlSession,
  input: DatabaseQueryInput,
  writable: boolean
): Promise<DatabaseQueryResult> {
  const started = performance.now()
  // Each run is one transaction.
  await session.execute(session.dialect.begin(!writable))
  const result = await session.script(input.sql, input.maxRows)
  await session.execute(writable ? "COMMIT" : "ROLLBACK")
  return {
    ...result,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  }
}

// --- Mutate -----------------------------------------------------------------

async function mutate(
  session: SqlSession,
  input: DatabaseMutateInput
): Promise<DatabaseMutateResult> {
  const table = await requireTable(session, input.table)
  if (table.kind !== "table" || table.rowIdentity !== "primary-key") {
    throw browserError(
      "read_only_table",
      `${table.name} has no primary key, so its rows cannot be edited`
    )
  }
  const writable = new Set(
    table.columns.filter(({ generated }) => !generated).map(({ name }) => name)
  )

  // All changes land together or not at all. A conflict doesn't stop the
  // pass, so the client learns about every conflicting row at once.
  await session.execute(session.dialect.begin(false))
  let committed = false
  try {
    let applied = 0
    const conflicts: Array<DatabaseConflict> = []
    for (const [index, change] of input.changes.entries()) {
      const changed = await applyChange(session, table, writable, change)
      if (changed === 0 && change.kind !== "insert") {
        conflicts.push({
          change: index,
          current: await currentRow(session, table, change.key),
        })
        continue
      }
      if (changed > 1) {
        throw browserError(
          "ambiguous_row",
          "A change matched more than one row, so nothing was saved."
        )
      }
      applied += changed
    }
    if (conflicts.length > 0) return { applied: 0, conflicts }
    await session.execute("COMMIT")
    committed = true
    return { applied, conflicts }
  } finally {
    if (!committed) await session.execute("ROLLBACK").catch(() => undefined)
  }
}

async function applyChange(
  session: SqlSession,
  table: CatalogTable,
  writable: ReadonlySet<string>,
  change: DatabaseChange
): Promise<number> {
  const { dialect } = session
  const target = qualifiedName(dialect, table)
  const parameters = new Parameters(dialect)
  if (change.kind === "insert") {
    const entries = writableEntries(change.values, writable)
    const sql =
      entries.length === 0
        ? dialect.engine === "postgres"
          ? `INSERT INTO ${target} DEFAULT VALUES`
          : `INSERT INTO ${target} () VALUES ()`
        : `INSERT INTO ${target} (${entries
            .map(([name]) => dialect.quote(name))
            .join(", ")}) VALUES (${entries
            .map(([, value]) => parameters.add(writeValue(value)))
            .join(", ")})`
    return (await session.execute(sql, parameters.values)).changes ?? 0
  }

  if (change.kind === "update") {
    const entries = writableEntries(change.values, writable)
    if (entries.length === 0) {
      throw browserError("invalid_change", "The update is empty")
    }
    const assignments = entries
      .map(
        ([name, value]) =>
          `${dialect.quote(name)} = ${parameters.add(writeValue(value))}`
      )
      .join(", ")
    const where = rowCondition(dialect, table, change, parameters)
    return (
      (
        await session.execute(
          `UPDATE ${target} SET ${assignments} WHERE ${where}`,
          parameters.values
        )
      ).changes ?? 0
    )
  }

  const where = rowCondition(dialect, table, change, parameters)
  return (
    (
      await session.execute(
        `DELETE FROM ${target} WHERE ${where}`,
        parameters.values
      )
    ).changes ?? 0
  )
}

// Every update and delete finds its row by key and applies only while the
// row still holds the values the client loaded, so a row that changed is
// reported instead of overwritten.
function rowCondition(
  dialect: Dialect,
  table: CatalogTable,
  change: Extract<DatabaseChange, { key: DatabaseRowKey }>,
  parameters: Parameters
) {
  const names = primaryKeyColumns(table.columns).map(({ name }) => name)
  if (
    Object.keys(change.key).length !== names.length ||
    names.some((name) => !(name in change.key))
  ) {
    throw browserError(
      "invalid_key",
      "Row key does not match the table's primary key"
    )
  }
  const conditions = names.map((name) =>
    valueCondition(
      dialect,
      tableColumn(table, name),
      change.key[name] ?? null,
      parameters
    )
  )
  for (const column of table.columns) {
    if (!(column.name in change.original)) {
      throw browserError(
        "invalid_change",
        `The change is missing the original value of ${column.name}`
      )
    }
    conditions.push(
      valueCondition(
        dialect,
        column,
        change.original[column.name] ?? null,
        parameters
      )
    )
  }
  return conditions.join(" AND ")
}

// Values compare the way they were read: numbers and booleans natively,
// binary by bytes (a truncated preview by length and prefix), and everything
// else by its text form, which is exactly what the browser received.
function valueCondition(
  dialect: Dialect,
  column: DatabaseColumn,
  value: DatabaseValue,
  parameters: Parameters
) {
  const name = dialect.quote(column.name)
  const postgres = dialect.engine === "postgres"
  if (value === null) return `${name} IS NULL`
  if (typeof value === "object" && "$blob" in value) {
    const bytes = Buffer.from(value.$blob, "base64")
    if (value.truncated) {
      return postgres
        ? `(octet_length(${name}) = ${parameters.add(value.size)} AND substring(${name} FROM 1 FOR ${parameters.add(bytes.length)}) = ${parameters.add(bytes)})`
        : `(LENGTH(${name}) = ${parameters.add(value.size)} AND LEFT(${name}, ${parameters.add(bytes.length)}) = ${parameters.add(bytes)})`
    }
    return `${name} = ${parameters.add(bytes)}`
  }
  if (typeof value === "boolean" || isNativeNumber(column, value)) {
    return `${name} = ${parameters.add(writeValue(value))}`
  }
  const text = typeof value === "object" ? value.$bigint : String(value)
  return postgres
    ? `${name}::text = ${parameters.add(text)}`
    : `BINARY CAST(${name} AS CHAR) = BINARY ${parameters.add(text)}`
}

// Single-precision floats print shorter than the double they compare as, so
// they match by text like everything else.
function isNativeNumber(column: DatabaseColumn, value: DatabaseValue) {
  return (
    (typeof value === "number" ||
      (typeof value === "object" && value !== null && "$bigint" in value)) &&
    !/^(?:float(?!8)|real)\b/iu.test(column.type)
  )
}

async function currentRow(
  session: SqlSession,
  table: CatalogTable,
  key: DatabaseRowKey
) {
  const { dialect } = session
  const parameters = new Parameters(dialect)
  const where = primaryKeyColumns(table.columns)
    .map((column) =>
      valueCondition(dialect, column, key[column.name] ?? null, parameters)
    )
    .join(" AND ")
  const result = await session.execute(
    `SELECT ${table.columns
      .map(({ name }) => dialect.quote(name))
      .join(", ")} FROM ${qualifiedName(dialect, table)} WHERE ${where}`,
    parameters.values
  )
  const row = result.rows[0]
  return row
    ? Object.fromEntries(
        table.columns.map(({ name }, index) => [name, row[index] ?? null])
      )
    : null
}

function writableEntries(
  values: Record<string, DatabaseValue>,
  writable: ReadonlySet<string>
) {
  const entries = Object.entries(values)
  for (const [name] of entries) {
    if (!writable.has(name)) {
      throw browserError(
        "unknown_column",
        `Column ${name} does not exist or cannot be written`
      )
    }
  }
  return entries
}

function tableColumn(table: CatalogTable, name: string) {
  const column = table.columns.find((candidate) => candidate.name === name)
  if (!column) throw browserError("unknown_column", `Unknown column ${name}`)
  return column
}

class Parameters {
  readonly values: Array<unknown> = []
  constructor(readonly dialect: Dialect) {}
  add(value: unknown) {
    this.values.push(value)
    return this.dialect.placeholder(this.values.length)
  }
}

function writeValue(value: DatabaseValue): unknown {
  if (value === null) return null
  if (typeof value !== "object") return value
  if ("$bigint" in value) return value.$bigint
  if (value.truncated) {
    throw browserError(
      "truncated_blob",
      "Truncated blob previews cannot be written back"
    )
  }
  return Buffer.from(value.$blob, "base64")
}

// --- Values -----------------------------------------------------------------

const PG_BOOL = 16
const PG_BYTEA = 17
const PG_INT8 = 20
const PG_INTEGERS = new Set([21, 23, 26])
const PG_FLOATS = new Set([700, 701])

function decodePostgresText(value: string | null, oid: number): DatabaseValue {
  if (value === null) return null
  if (oid === PG_BOOL) return value === "t"
  if (oid === PG_INT8) return integerValue(value)
  if (PG_INTEGERS.has(oid)) return Number(value)
  if (PG_FLOATS.has(oid)) {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (oid === PG_BYTEA && value.startsWith("\\x")) {
    return blobValue(Buffer.from(value.slice(2), "hex"))
  }
  return value
}

// mysql2 column type codes (MYSQL_TYPE_*).
const MYSQL_INTEGERS = new Set([1, 2, 3, 9, 13])
const MYSQL_LONGLONG = 8
const MYSQL_FLOATS = new Set([4, 5])
const MYSQL_BINARY_CAPABLE = new Set([
  15, 16, 249, 250, 251, 252, 253, 254, 255,
])
const MYSQL_BINARY_CHARSET = 63
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINYBLOB",
  250: "MEDIUMBLOB",
  251: "LONGBLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "CHAR",
  255: "GEOMETRY",
}

function mysqlResultColumn(field: mysql.FieldPacket): DatabaseResultColumn {
  const code = field.columnType ?? -1
  const name = MYSQL_TYPE_NAMES[code] ?? null
  if (MYSQL_BINARY_CAPABLE.has(code)) {
    const binary = field.characterSet === MYSQL_BINARY_CHARSET
    if (code >= 249 && code <= 252) {
      return { name: field.name, type: binary ? "BLOB" : "TEXT" }
    }
    if (binary && name !== "BIT" && name !== "GEOMETRY") {
      return { name: field.name, type: "VARBINARY" }
    }
  }
  return { name: field.name, type: name }
}

function decodeMysqlValue(
  value: Buffer | null,
  field: mysql.FieldPacket | undefined
): DatabaseValue {
  if (value === null) return null
  const code = field?.columnType ?? -1
  if (
    MYSQL_BINARY_CAPABLE.has(code) &&
    field?.characterSet === MYSQL_BINARY_CHARSET
  ) {
    return blobValue(value)
  }
  const text = value.toString("utf8")
  if (code === MYSQL_LONGLONG) return integerValue(text)
  if (MYSQL_INTEGERS.has(code)) return Number(text)
  if (MYSQL_FLOATS.has(code)) {
    const number = Number(text)
    return Number.isFinite(number) ? number : text
  }
  return text
}

function integerValue(text: string): DatabaseValue {
  const value = BigInt(text)
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : { $bigint: value.toString() }
}

function blobValue(bytes: Buffer): DatabaseValue {
  const truncated = bytes.byteLength > BLOB_PREVIEW_BYTES
  return {
    $blob: (truncated ? bytes.subarray(0, BLOB_PREVIEW_BYTES) : bytes).toString(
      "base64"
    ),
    size: bytes.byteLength,
    truncated,
  }
}

function numberValue(value: DatabaseValue | undefined) {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number(value)
  if (value && typeof value === "object" && "$bigint" in value) {
    return Number(value.$bigint)
  }
  return null
}

function primaryKeyColumns(columns: ReadonlyArray<DatabaseColumn>) {
  return columns
    .filter(({ primaryKey }) => primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey)
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`)
}

function browserError(code: string, reason: string) {
  return RelayDatabaseBrowserError.make({ code, reason })
}

function attempt<TResult>(operation: string, run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RelayDatabaseBrowserError
        ? cause
        : RelayDatabaseBrowserError.make({
            code: `${operation}_failed`,
            reason:
              cause instanceof Error
                ? cause.message
                : "The database operation failed",
            cause,
          }),
  })
}
