import { Effect, Result } from "effect"
import { SqlClient } from "effect/sql"

import { isMigrationSnapshotTable } from "@/effect/migration-snapshot"
import type { Migration } from "@/effect/migrations"
import { databaseTableName, databaseTablePrefix } from "@/lib/database-config"

/**
 * "Instance" means any kind of instance, and a game server is a `server`
 * (see docs/instance-ids.md). What Hearth stores says so too, in every
 * record:
 *
 * 1. A game server's tables are `server`, `server_domain`,
 *    `server_domain_opt_out` and `server_post_provision`, their indexes and
 *    foreign keys named after them. Their `instance_id` columns keep their
 *    name: a game server is an instance.
 * 2. Every enum that lists `instance` lists `server` in its place, and its
 *    rows say `server`.
 * 3. Every record that names a game server's kind, permission, lane or
 *    Tailscale member by `instance` names it by `server`: kind fields,
 *    `instance.*` permissions, collections, actions and operation names,
 *    `instance:` lane keys, member IDs and resource keys, in columns and
 *    inside JSON. Each is found by the field it's in, never wherever the
 *    word turns up, so names, commands and paths keep what they say.
 *
 * Each step finds what's left to do, so running it again after a crash
 * carries on where it stopped.
 */
export const serverNaming: Migration = {
  id: 60,
  name: "server_naming",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* renameTables(sql)
    yield* renameEnumValues(sql)
    yield* sql.withTransaction(rewriteRecords(sql))
  }),
}

const table = databaseTableName

type Sql = SqlClient.SqlClient

/** Kiln's own tables, the operations engine's among them, without a snapshot's. */
function isHearthTable(name: string): boolean {
  return (
    name.startsWith(databaseTablePrefix()) && !isMigrationSnapshotTable(name)
  )
}

// --- 1. Tables ---------------------------------------------------------------

const renamedTables = [
  ["instance", "server"],
  ["instance_domain", "server_domain"],
  ["instance_domain_opt_out", "server_domain_opt_out"],
  ["instance_post_provision", "server_post_provision"],
] as const

const renameTables = Effect.fn("migration.serverNaming.tables")(function* (
  sql: Sql
) {
  for (const [from, to] of renamedTables) {
    const before = table(from)
    const after = table(to)
    if (!(yield* tableExists(sql, after))) {
      if (!(yield* tableExists(sql, before))) continue
      yield* sql.unsafe(`RENAME TABLE \`${before}\` TO \`${after}\``)
    }
    // Foreign keys from other tables follow the rename; the table's own
    // keys and indexes keep the names they were made with until renamed.
    yield* renameForeignKeys(sql, before, after)
    yield* renameIndexes(sql, before, after)
  }
})

interface ForeignKeyColumn {
  readonly name: string
  readonly column_name: string
  readonly referenced_table: string
  readonly referenced_column: string
  readonly update_rule: string
  readonly delete_rule: string
}

// MySQL can't rename a foreign key: the new one is added before the old one
// is dropped, so a run that stops between the two finds the old one again.
// One connection throughout, its checks off, so adding one doesn't rebuild
// the table to check rows the old one already kept.
const renameForeignKeys = Effect.fnUntraced(function* (
  sql: Sql,
  before: string,
  after: string
) {
  const rows = yield* sql.unsafe<ForeignKeyColumn>(
    `SELECT k.constraint_name AS name, k.column_name AS column_name,
  k.referenced_table_name AS referenced_table,
  k.referenced_column_name AS referenced_column,
  r.update_rule AS update_rule, r.delete_rule AS delete_rule
FROM information_schema.key_column_usage k
JOIN information_schema.referential_constraints r
  ON r.constraint_schema = k.constraint_schema
 AND r.constraint_name = k.constraint_name
 AND r.table_name = k.table_name
WHERE k.table_schema = DATABASE() AND k.table_name = ?
  AND k.referenced_table_name IS NOT NULL
ORDER BY k.constraint_name, k.ordinal_position`,
    [after]
  )
  const keys = new Map<string, Array<ForeignKeyColumn>>()
  for (const row of rows) {
    let columns = keys.get(row.name)
    if (!columns) keys.set(row.name, (columns = []))
    columns.push(row)
  }
  const renames = [...keys].filter(([name]) => name.startsWith(`${before}_`))
  if (renames.length === 0) return
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 0")
      for (const [name, columns] of renames) {
        const renamed = `${after}${name.slice(before.length)}`
        const first = columns[0]!
        if (!keys.has(renamed)) {
          yield* sql.unsafe(`ALTER TABLE \`${after}\`
  ADD CONSTRAINT \`${renamed}\` FOREIGN KEY (${columns.map((column) => `\`${column.column_name}\``).join(", ")})
  REFERENCES \`${first.referenced_table}\` (${columns.map((column) => `\`${column.referenced_column}\``).join(", ")})
  ON DELETE ${first.delete_rule} ON UPDATE ${first.update_rule}`)
        }
        yield* sql.unsafe(
          `ALTER TABLE \`${after}\` DROP FOREIGN KEY \`${name}\``
        )
      }
    }).pipe(
      Effect.ensuring(
        sql.unsafe("SET FOREIGN_KEY_CHECKS = 1").pipe(Effect.ignore)
      )
    )
  )
})

const renameIndexes = Effect.fnUntraced(function* (
  sql: Sql,
  before: string,
  after: string
) {
  const indexes = yield* sql.unsafe<{ name: string }>(
    `SELECT DISTINCT index_name AS name FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = ?`,
    [after]
  )
  const renames = indexes
    .map((index) => index.name)
    .filter((name) => name.startsWith(`${before}_`))
    .map(
      (name) =>
        `RENAME INDEX \`${name}\` TO \`${after}${name.slice(before.length)}\``
    )
  if (renames.length > 0) {
    yield* sql.unsafe(`ALTER TABLE \`${after}\` ${renames.join(", ")}`)
  }
})

// --- 2. Enums ----------------------------------------------------------------

interface EnumColumn {
  readonly table_name: string
  readonly column_name: string
  readonly column_type: string
  readonly is_nullable: string
  readonly column_default: string | null
  readonly character_set_name: string | null
  readonly collation_name: string | null
  readonly column_comment: string | null
}

// Each table's enums take `server` beside `instance`, their rows move to it,
// and then `instance` goes, so no row ever holds a value its column lacks.
const renameEnumValues = Effect.fn("migration.serverNaming.enums")(function* (
  sql: Sql
) {
  const columns = (yield* sql.unsafe<EnumColumn>(
    `SELECT table_name AS table_name, column_name AS column_name,
  column_type AS column_type, is_nullable AS is_nullable,
  column_default AS column_default,
  character_set_name AS character_set_name, collation_name AS collation_name,
  column_comment AS column_comment
FROM information_schema.columns
WHERE table_schema = DATABASE() AND data_type = 'enum'
ORDER BY table_name, ordinal_position`
  )).filter(
    (column) =>
      isHearthTable(column.table_name) &&
      enumValues(column.column_type).includes("instance")
  )
  const byTable = new Map<string, Array<EnumColumn>>()
  for (const column of columns) {
    let list = byTable.get(column.table_name)
    if (!list) byTable.set(column.table_name, (list = []))
    list.push(column)
  }
  for (const [name, list] of byTable) {
    const widened = list.flatMap((column) => {
      const values = enumValues(column.column_type)
      return values.includes("server")
        ? []
        : [enumDefinition(column, [...values, "server"])]
    })
    if (widened.length > 0) {
      yield* sql.unsafe(`ALTER TABLE \`${name}\` ${widened.join(", ")}`)
    }
    for (const column of list) {
      yield* sql.unsafe(
        `UPDATE \`${name}\` SET \`${column.column_name}\` = 'server'
WHERE \`${column.column_name}\` = 'instance'`
      )
    }
    yield* sql.unsafe(
      `ALTER TABLE \`${name}\` ${list
        .map((column) =>
          enumDefinition(column, [
            ...new Set(
              enumValues(column.column_type).map((value) =>
                value === "instance" ? "server" : value
              )
            ),
          ])
        )
        .join(", ")}`
    )
  }
  yield* Effect.logInfo("Server naming migration renamed enum values", {
    columns: columns.length,
  })
})

function enumValues(columnType: string): Array<string> {
  return [...columnType.matchAll(/'((?:[^']|'')*)'/gu)].map((match) =>
    match[1]!.replaceAll("''", "'")
  )
}

function literal(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
}

// MySQL reports a string default bare and MariaDB quoted, and MariaDB a
// nullable column's missing default as the word NULL.
function enumDefault(column: EnumColumn): string | null {
  const reported = column.column_default
  if (reported === null || reported === "NULL") return null
  const value =
    reported.length >= 2 && reported.startsWith("'") && reported.endsWith("'")
      ? reported.slice(1, -1).replaceAll("''", "'")
      : reported
  return value === "instance" ? "server" : value
}

function enumDefinition(column: EnumColumn, values: ReadonlyArray<string>) {
  const fallback = enumDefault(column)
  return [
    `MODIFY \`${column.column_name}\` enum(${values.map(literal).join(",")})`,
    column.character_set_name
      ? `CHARACTER SET ${column.character_set_name}`
      : "",
    column.collation_name ? `COLLATE ${column.collation_name}` : "",
    column.is_nullable === "YES" ? "NULL" : "NOT NULL",
    fallback === null ? "" : `DEFAULT ${literal(fallback)}`,
    column.column_comment ? `COMMENT ${literal(column.column_comment)}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ")
}

// --- 3. Records --------------------------------------------------------------

// Tables with nothing that names a game server by kind, or whose records
// must keep what they say: sign-in records, ledgers, the instance directory
// (its kinds already say `server`), signed pairing records, Bricks, release
// notes, vulnerability data, and the operations engine's own bookkeeping.
const skippedTables = new Set(
  [
    "account",
    "auth_audit",
    "brick_catalog",
    "custom_brick",
    "data_migration",
    "instance_id",
    "ops_locks",
    "ops_migrations",
    "ops_runner_migrations",
    "ops_runners",
    "passkey",
    "rateLimit",
    "relay_join",
    "schema_migration",
    "security_finding",
    "security_sbom",
    "security_vulnerability",
    "session",
    "system_release",
    "twoFactor",
    "user",
    "verification",
  ].map((name) => table(name))
)

// The paths of backups already in storage name where their objects are.
const keptColumns = new Set(
  [
    ["backup", "object_key"],
    ["backup_artifact", "object_key"],
    ["backup_repository", "object_prefix"],
  ].map(([name, column]) => `${table(name!)}.${column}`)
)
const secretColumn = /ciphertext|secret|password|token|private_key/iu

const textTypes = new Set([
  "char",
  "varchar",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "json",
])

const rewriteRecords = Effect.fn("migration.serverNaming.records")(function* (
  sql: Sql
) {
  const columns = yield* sql.unsafe<{
    table_name: string
    column_name: string
    data_type: string
  }>(`SELECT table_name AS table_name, column_name AS column_name,
  data_type AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position`)
  const keys = yield* sql.unsafe<{ table_name: string; column_name: string }>(
    `SELECT table_name AS table_name, column_name AS column_name
FROM information_schema.key_column_usage
WHERE table_schema = DATABASE() AND constraint_name = 'PRIMARY'
ORDER BY table_name, ordinal_position`
  )
  const tables = new Map<string, Array<string>>()
  for (const column of columns) {
    if (!isHearthTable(column.table_name)) continue
    if (skippedTables.has(column.table_name)) continue
    if (!textTypes.has(column.data_type.toLowerCase())) continue
    if (keptColumns.has(`${column.table_name}.${column.column_name}`)) continue
    if (secretColumn.test(column.column_name)) continue
    let list = tables.get(column.table_name)
    if (!list) tables.set(column.table_name, (list = []))
    list.push(column.column_name)
  }
  const primaryKeys = new Map<string, Array<string>>()
  for (const key of keys) {
    let list = primaryKeys.get(key.table_name)
    if (!list) primaryKeys.set(key.table_name, (list = []))
    list.push(key.column_name)
  }
  let rewritten = 0
  for (const [name, textColumns] of tables) {
    const primaryKey = primaryKeys.get(name)
    if (!primaryKey || primaryKey.length === 0) continue
    rewritten += yield* rewriteTable(sql, name, primaryKey, textColumns)
  }
  yield* Effect.logInfo("Server naming migration rewrote records", {
    rewritten,
  })
})

const rewriteTable = Effect.fnUntraced(function* (
  sql: Sql,
  name: string,
  primaryKey: ReadonlyArray<string>,
  textColumns: ReadonlyArray<string>
) {
  const read = (column: string) => `CAST(\`${column}\` AS CHAR)`
  // Primary keys first, read once, so a rewrite never moves a row past the
  // next page.
  const candidates = yield* sql.unsafe<Record<string, unknown>>(
    `SELECT ${primaryKey.map((key) => `\`${key}\``).join(", ")}
FROM \`${name}\`
WHERE ${textColumns.map((column) => `${read(column)} LIKE '%instance%'`).join(" OR ")}`
  )
  let changed = 0
  for (let start = 0; start < candidates.length; start += 500) {
    const page = candidates.slice(start, start + 500)
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${primaryKey.map((key) => `\`${key}\` AS \`pk_${key}\``).join(", ")},
  ${textColumns.map((column) => `${read(column)} AS \`${column}\``).join(", ")}
FROM \`${name}\`
WHERE (${primaryKey.map((key) => `\`${key}\``).join(", ")}) IN (${page
        .map(() => `(${primaryKey.map(() => "?").join(", ")})`)
        .join(", ")})`,
      page.flatMap((row) => primaryKey.map((key) => row[key] as never))
    )
    for (const row of rows) {
      const updates: Array<[string, string]> = []
      for (const column of textColumns) {
        const value = row[column]
        if (typeof value !== "string" || !value.includes("instance")) continue
        const next = rewriteText(column, value)
        if (next !== value) updates.push([column, next])
      }
      if (updates.length === 0) continue
      yield* sql.unsafe(
        `UPDATE \`${name}\`
SET ${updates.map(([column]) => `\`${column}\` = ?`).join(", ")}
WHERE ${primaryKey.map((key) => `\`${key}\` = ?`).join(" AND ")}`,
        [
          ...updates.map(([, value]) => value),
          ...primaryKey.map((key) => row[`pk_${key}`] as never),
        ]
      )
      changed += 1
    }
  }
  return changed
})

// Which fields say what, by name, in columns (`target_kind`) and in JSON
// (`resourceType`, `locks`, `memberId`). A list of them, such as `targetKinds`
// or `permissions`, says the same of each item.

/** A kind: `instance` itself is a game server. */
const KIND_FIELD =
  /^(?:kinds?|types?|family|families)$|(?:Kinds?|Types?|_kinds?|_types?)$/u

/** Permissions, their collections, Relay actions and operation names. */
const NAME_FIELD =
  /^(?:keys?|permissions?|actions?|client_actions|operations?|events?|kinds?|methods?|selection_key|selectionKeys?)$/u
// `instance.files.write`, `instance.console.all`, and a game server's
// backup operations, `backup.instance.create`.
const NAME_SHAPE = /^(backup\.)?instance((?:\.[a-z][a-z0-9-]*)+)$/u

/** Lane keys, Tailscale member IDs and resource keys. */
const KEY_FIELD =
  /^(?:keys?|locks?|lanes?|members?|memberIds?|member_id|blockedBy|resourceKeys?|scopeKeys?|targetKeys?|target_key)$/u
// `instance:<id>`, `instance:<relay>:<id>`, `instance:<relay>/<id>#<part>`,
// and a schedule target's `<relay>:instance:<id>`.
const KEY_SHAPE =
  /^([a-f0-9]{12}:)?instance(:[A-Za-z0-9_-]+(?:[/:][A-Za-z0-9_-]+)?(?:#[A-Za-z0-9_:.-]+)?)$/u

function renameKey(value: string): string {
  const key = KEY_SHAPE.exec(value)
  return key ? `${key[1] ?? ""}server${key[2]}` : value
}

function rewriteField(field: string, value: string): string {
  if (value === "instance" && KIND_FIELD.test(field)) return "server"
  const name = NAME_FIELD.test(field) ? NAME_SHAPE.exec(value) : null
  if (name) return `${name[1] ?? ""}server${name[2]}`
  return KEY_FIELD.test(field) ? renameKey(value) : value
}

/** A column's value: JSON throughout, or the column's own field. */
function rewriteText(column: string, value: string): string {
  const start = value.trimStart()[0]
  if (start === "{" || start === "[") {
    const decoded = Result.try(() => JSON.parse(value) as unknown)
    if (Result.isSuccess(decoded)) {
      const state = { changed: false }
      const next = rewriteJson(decoded.success, column, state)
      return state.changed ? JSON.stringify(next) : value
    }
  }
  return rewriteField(column, value)
}

function rewriteJson(
  value: unknown,
  field: string,
  state: { changed: boolean }
): unknown {
  if (typeof value === "string") {
    const next = rewriteField(field, value)
    if (next !== value) state.changed = true
    return next
  }
  if (Array.isArray(value))
    return value.map((item) => rewriteJson(item, field, state))
  if (value === null || typeof value !== "object") return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // An object keyed by resource, as notification settings and a schedule
    // action's services are.
    const renamed = renameKey(key)
    if (renamed !== key) state.changed = true
    next[renamed] = rewriteJson(item, key, state)
  }
  return next
}

// --- Schema reads -----------------------------------------------------------

function tableExists(sql: Sql, name: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = ?`,
      [name]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
