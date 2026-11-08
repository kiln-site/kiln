import {
  isLegacyRelayId,
  isLegacyResourceId,
  legacyIdRewriter,
  migratedInstanceId,
  type InstanceIdKind,
  type LegacyIdRewriter,
} from "@workspace/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

/**
 * Every instance takes its 12-character ID (see
 * packages/contracts/src/instance-id-migration.ts), in every record that
 * names it.
 *
 * 1. The instance directory, `instance_id`, reserves every ID from now on,
 *    and each Relay's fingerprint moves to a column of its own, since it no
 *    longer is the Relay's ID.
 * 2. Every old ID any typed column names, of a live instance or a deleted
 *    one, gets its new ID, reserved beside the old one. Two old IDs that
 *    came to the same new one would stop the migration here.
 * 3. One transaction then rewrites every old ID in every table: ID columns,
 *    JSON, lock keys, file roots, settings, notifications, encrypted App
 *    configurations. Signed pairing records, key material, and the paths of
 *    backups already in storage keep what they say.
 * 4. ID columns shrink to the new length, their foreign keys dropped and
 *    added back around it.
 *
 * Each step finds what's left to do, so running it again after a crash
 * carries on where it stopped.
 */
export const instanceIds: Migration = {
  id: 58,
  name: "instance_ids",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* createDirectory(sql)
    const mapping = yield* reserveMappedIds(sql)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 0")
        yield* rewriteTables(sql, mapping)
        yield* rewriteAppConfigs(sql, mapping)
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 1")
      })
    )
    yield* shrinkIdColumns(sql)
  }),
}

const table = databaseTableName

type Sql = SqlClient.SqlClient

// --- 1. The directory -------------------------------------------------------

const createDirectory = Effect.fn("migration.instanceIds.directory")(function* (
  sql: Sql
) {
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${table("instance_id")}\` (
  \`id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`kind\` enum('relay','server','app','database','tailscale') NOT NULL,
  \`legacy_id\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  \`legacy_scope\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  \`relay_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NULL,
  \`request_key\` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  \`created_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`${table("instance_id")}_request_key\` (\`request_key\`),
  KEY \`${table("instance_id")}_legacy_idx\` (\`legacy_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  // A game server's ID is bound to the Relay that runs it.
  if (!(yield* columnExists(sql, table("instance_id"), "relay_id"))) {
    yield* sql.unsafe(`ALTER TABLE \`${table("instance_id")}\`
  ADD COLUMN \`relay_id\` char(12) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER \`legacy_scope\``)
  }
  const relay = table("relay")
  if (!(yield* columnExists(sql, relay, "fingerprint"))) {
    yield* sql.unsafe(`ALTER TABLE \`${relay}\`
  ADD COLUMN \`fingerprint\` char(43) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER \`id\`,
  ADD UNIQUE KEY \`${relay}_fingerprint\` (\`fingerprint\`)`)
  }
  // Until now a Relay's ID was its fingerprint.
  yield* sql.unsafe(`UPDATE \`${relay}\` SET fingerprint = id
WHERE fingerprint IS NULL AND CHAR_LENGTH(id) = 43`)
})

// --- 2. New IDs for old ones -------------------------------------------------

interface MappedId {
  readonly id: string
  readonly kind: InstanceIdKind
  readonly legacyId: string
  /** A game server's Relay's fingerprint; its old ID was only unique there. */
  readonly scope: string | null
}

interface Mapping {
  /** Old IDs anything names, without a game server's Relay to go by. */
  readonly global: LegacyIdRewriter
  readonly globalIds: ReadonlyMap<string, string>
  readonly relays: ReadonlyMap<string, string>
  /** With a Relay to go by: its game servers too. */
  readonly forRelay: (fingerprint: string) => LegacyIdRewriter
}

// Columns that name an instance, by kind. `kindColumn` picks the kind per
// row; a value it doesn't list isn't an instance this migration renames
// (a volume, the platform, a user's icon).
interface IdColumn {
  readonly table: string
  readonly column: string
  /**
   * The column naming the Relay its game servers are on, when not the
   * row's `relay_id`; null when the row doesn't say.
   */
  readonly relayColumn?: string | null
  readonly kind:
    | InstanceIdKind
    | {
        readonly column: string
        readonly values: Readonly<Record<string, InstanceIdKind>>
      }
}

const resourceKinds = {
  app: "app",
  database: "database",
  instance: "server",
  relay: "relay",
  server: "server",
} as const satisfies Record<string, InstanceIdKind>

const relayIdColumns: ReadonlyArray<IdColumn> = [
  ["relay", "id"],
  ["access_grant", "relay_id"],
  ["app", "relay_id"],
  ["app_deployment", "relay_id"],
  ["audit_event", "relay_id"],
  ["authorization_delivery", "relay_id"],
  ["backup", "relay_id"],
  ["backup_policy", "relay_id"],
  ["backup_repository", "relay_id"],
  ["database", "relay_id"],
  ["file_activity", "relay_id"],
  ["github_sync", "relay_id"],
  ["hostname_claim", "relay_id"],
  ["icon", "relay_id"],
  ["instance", "relay_id"],
  ["instance_domain", "relay_id"],
  ["instance_domain_opt_out", "relay_id"],
  ["instance_favorite", "relay_id"],
  ["instance_post_provision", "relay_id"],
  ["invitation", "relay_id"],
  ["permission_preset", "relay_id"],
  ["relay_database_connection_import", "relay_id"],
  ["relay_join", "paired_relay_id"],
  ["resource_deletion", "relay_id"],
  ["schedule_deployment", "relay_id"],
  ["schedule_run", "relay_id"],
  ["schedule_target", "relay_id"],
  ["security_alert", "relay_id"],
  ["security_finding", "relay_id"],
  ["security_sbom", "relay_id"],
  ["security_target", "relay_id"],
  ["server_migration", "source_relay_id"],
  ["server_migration", "destination_relay_id"],
  ["tailscale_network_deployment", "relay_id"],
  ["web_hostname", "relay_id"],
].map(([name, column]) => ({
  column: column!,
  kind: "relay" as const,
  table: name!,
}))

const instanceIdColumns: ReadonlyArray<IdColumn> = [
  ...relayIdColumns,
  { table: "instance", column: "instance_id", kind: "server" },
  { table: "instance_domain", column: "instance_id", kind: "server" },
  { table: "instance_domain_opt_out", column: "instance_id", kind: "server" },
  { table: "instance_post_provision", column: "instance_id", kind: "server" },
  { table: "file_activity", column: "instance_id", kind: "server" },
  { table: "invitation", column: "instance_id", kind: "server" },
  { table: "invitation", column: "database_id", kind: "database" },
  {
    table: "server_migration",
    column: "source_instance_id",
    relayColumn: "source_relay_id",
    kind: "server",
  },
  {
    table: "server_migration",
    column: "destination_instance_id",
    relayColumn: "destination_relay_id",
    kind: "server",
  },
  { table: "app", column: "app_id", kind: "app" },
  { table: "app_deployment", column: "app_id", kind: "app" },
  { table: "app_github_source", column: "app_id", kind: "app" },
  { table: "app_image_update", column: "app_id", kind: "app" },
  { table: "app_image_update_attempt", column: "app_id", kind: "app" },
  { table: "file_activity", column: "app_id", kind: "app" },
  { table: "database", column: "database_id", kind: "database" },
  { table: "tailscale_network", column: "id", kind: "tailscale" },
  {
    table: "tailscale_network_deployment",
    column: "network_id",
    kind: "tailscale",
  },
  ...(
    [
      ["access_grant", "resource_id", "resource_type"],
      ["permission_preset", "resource_id", "resource_type"],
      ["instance_favorite", "resource_id", "resource_kind"],
      ["github_sync", "resource_id", "resource_kind"],
      ["security_target", "resource_id", "resource_type"],
      ["hostname_claim", "resource_id", "resource_type"],
      ["web_hostname", "resource_id", "resource_type"],
      ["schedule_target", "target_id", "target_kind"],
      ["resource_deletion", "resource_id", "resource_kind"],
      ["backup", "target_id", "target_kind"],
      ["backup_policy", "target_id", "target_kind"],
      ["backup_repository", "target_id", "target_kind"],
      ["icon", "subject_id", "subject_kind"],
    ] as const
  ).map(([name, column, kindColumn]) => ({
    column,
    kind: { column: kindColumn, values: resourceKinds },
    table: name,
  })),
  {
    table: "authorization_delivery",
    column: "scope_id",
    kind: { column: "scope_kind", values: { instance: "server" } },
  },
  // The server a linked backup was made of may be on another Relay.
  {
    table: "backup",
    column: "linked_from_target_id",
    relayColumn: null,
    kind: "server",
  },
  {
    table: "backup_task",
    column: "target_id",
    kind: { column: "target_kind", values: resourceKinds },
  },
  {
    table: "backup_download_share",
    column: "target_id",
    kind: { column: "target_kind", values: resourceKinds },
  },
  {
    table: "audit_event",
    column: "target_id",
    kind: {
      column: "target_kind",
      values: { ...resourceKinds, "tailscale-network": "tailscale" },
    },
  },
]

const reserveMappedIds = Effect.fn("migration.instanceIds.reserve")(function* (
  sql: Sql
) {
  const found = new Map<string, MappedId>()
  const add = (mapped: MappedId) =>
    found.set(
      `${mapped.kind}\u0000${mapped.scope ?? ""}\u0000${mapped.legacyId}`,
      mapped
    )

  // What an earlier, interrupted run reserved, for rows it already rewrote.
  const reserved = yield* sql.unsafe<{
    id: string
    kind: InstanceIdKind
    legacy_id: string
    legacy_scope: string | null
  }>(`SELECT id, kind, legacy_id, legacy_scope FROM \`${table("instance_id")}\`
WHERE legacy_id IS NOT NULL`)
  for (const row of reserved) {
    add({
      id: row.id,
      kind: row.kind,
      legacyId: row.legacy_id,
      scope: row.legacy_scope,
    })
  }

  for (const source of instanceIdColumns) {
    const name = table(source.table)
    if (!(yield* columnExists(sql, name, source.column))) continue
    const relayColumn =
      source.relayColumn === null
        ? null
        : (source.relayColumn ??
          (source.kind === "relay" || source.column === "relay_id"
            ? null
            : (yield* columnExists(sql, name, "relay_id"))
              ? "relay_id"
              : null))
    const kindColumn = typeof source.kind === "string" ? null : source.kind
    const rows = yield* sql.unsafe<{
      id: string | null
      kind: string | null
      relay: string | null
    }>(`SELECT DISTINCT
  CAST(\`${source.column}\` AS CHAR) AS id,
  ${kindColumn ? `CAST(\`${kindColumn.column}\` AS CHAR)` : "NULL"} AS kind,
  ${relayColumn ? `CAST(\`${relayColumn}\` AS CHAR)` : "NULL"} AS relay
FROM \`${name}\``)
    for (const row of rows) {
      if (!row.id) continue
      const kind =
        typeof source.kind === "string"
          ? source.kind
          : row.kind === null
            ? undefined
            : source.kind.values[row.kind]
      if (!kind) continue
      if (kind === "relay") {
        if (isLegacyRelayId(row.id)) {
          add({
            id: yield* migrated({ kind, fingerprint: row.id }),
            kind,
            legacyId: row.id,
            scope: null,
          })
        }
        continue
      }
      if (!isLegacyResourceId(row.id)) continue
      if (kind === "server") {
        // A game server's old ID is only meaningful with its Relay's.
        if (!row.relay || !isLegacyRelayId(row.relay)) continue
        add({
          id: yield* migrated({
            kind,
            relayFingerprint: row.relay,
            id: row.id,
          }),
          kind,
          legacyId: row.id,
          scope: row.relay,
        })
        continue
      }
      add({
        id: yield* migrated({ kind, id: row.id }),
        kind,
        legacyId: row.id,
        scope: null,
      })
    }
  }

  const now = Date.now()
  const entries = [...found.values()]
  // A game server's Relay, by its new ID, which its ID is bound to.
  const relayOf = new Map<string, string>()
  for (const entry of entries) {
    if (entry.scope !== null && !relayOf.has(entry.scope)) {
      relayOf.set(
        entry.scope,
        yield* migrated({ kind: "relay", fingerprint: entry.scope })
      )
    }
  }
  for (let start = 0; start < entries.length; start += 200) {
    const batch = entries.slice(start, start + 200)
    yield* sql.unsafe(
      `INSERT IGNORE INTO \`${table("instance_id")}\`
  (id, kind, legacy_id, legacy_scope, relay_id, request_key, created_at)
VALUES ${batch.map(() => "(?, ?, ?, ?, ?, NULL, ?)").join(", ")}`,
      batch.flatMap((entry) => [
        entry.id,
        entry.kind,
        entry.legacyId,
        entry.scope,
        entry.scope === null ? null : (relayOf.get(entry.scope) ?? null),
        now,
      ])
    )
  }
  // Each new ID must now belong to exactly the old one it came from.
  const holders = new Map(
    (yield* sql.unsafe<{
      id: string
      kind: string
      legacy_id: string | null
      legacy_scope: string | null
    }>(`SELECT id, kind, legacy_id, legacy_scope
FROM \`${table("instance_id")}\``)).map((row) => [row.id, row])
  )
  for (const entry of entries) {
    const holder = holders.get(entry.id)
    if (
      !holder ||
      holder.kind !== entry.kind ||
      holder.legacy_id !== entry.legacyId ||
      (holder.legacy_scope ?? null) !== entry.scope
    ) {
      return yield* Effect.fail(
        new Error(
          `Instance ID migration: ${entry.kind} ${entry.legacyId} and another instance both map to ${entry.id}`
        )
      )
    }
  }

  const relays = new Map<string, string>()
  const globalIds = new Map<string, string>()
  const servers = new Map<string, Map<string, string>>()
  const ambiguous = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "relay") {
      relays.set(entry.legacyId, entry.id)
      globalIds.set(entry.legacyId, entry.id)
    } else if (entry.kind === "server") {
      let byRelay = servers.get(entry.scope!)
      if (!byRelay) servers.set(entry.scope!, (byRelay = new Map()))
      byRelay.set(entry.legacyId, entry.id)
      const other = globalIds.get(entry.legacyId)
      if (other !== undefined && other !== entry.id)
        ambiguous.add(entry.legacyId)
      else globalIds.set(entry.legacyId, entry.id)
    } else {
      globalIds.set(entry.legacyId, entry.id)
    }
  }
  // The same old game server ID on two Relays is renamed only where a row
  // says which Relay it means.
  for (const id of ambiguous) globalIds.delete(id)
  const global = legacyIdRewriter(globalIds)
  const perRelay = new Map<string, LegacyIdRewriter>()
  yield* Effect.logInfo("Instance ID migration mapped old IDs", {
    ambiguous: ambiguous.size,
    ids: entries.length,
  })
  return {
    forRelay: (fingerprint) => {
      let rewriter = perRelay.get(fingerprint)
      if (!rewriter) {
        rewriter = legacyIdRewriter(
          new Map([...globalIds, ...(servers.get(fingerprint) ?? [])])
        )
        perRelay.set(fingerprint, rewriter)
      }
      return rewriter
    },
    global,
    globalIds,
    relays,
  } satisfies Mapping
})

function migrated(reference: Parameters<typeof migratedInstanceId>[0]) {
  return Effect.promise(() => migratedInstanceId(reference))
}

// --- 3. Rewriting every record ----------------------------------------------

// Tables with nothing that names an instance, or that this migration writes.
const skippedTables = new Set(
  [
    "account",
    "auth_audit",
    "data_migration",
    "instance_id",
    "passkey",
    "rateLimit",
    "schema_migration",
    "session",
    "twoFactor",
    "user",
    "verification",
  ].map((name) => table(name))
)

// Columns kept as they are: signed pairing records and key material, which
// a rewrite would invalidate, and the paths of backups already in storage,
// which name where their objects are.
const keptColumns = new Set(
  [
    ["relay", "fingerprint"],
    ["relay", "relay_public_key"],
    ["relay", "relay_ca_certificate"],
    ["relay", "client_id"],
    ["relay", "client_public_key"],
    ["relay_join", "claimed_fingerprint"],
    ["relay_join", "envelope"],
    ["relay_join", "pairing_request"],
    ["relay_join", "pairing_response"],
    ["relay_join", "client_public_key"],
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

const rewriteTables = Effect.fn("migration.instanceIds.rewrite")(function* (
  sql: Sql,
  mapping: Mapping
) {
  if (mapping.global.size === 0 && mapping.relays.size === 0) return
  const columns = yield* sql.unsafe<{
    table_name: string
    column_name: string
    data_type: string
  }>(`SELECT table_name AS table_name, column_name AS column_name,
  data_type AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position`)
  const keys = yield* sql.unsafe<{
    table_name: string
    column_name: string
  }>(`SELECT table_name AS table_name, column_name AS column_name
FROM information_schema.key_column_usage
WHERE table_schema = DATABASE() AND constraint_name = 'PRIMARY'
ORDER BY table_name, ordinal_position`)
  // Kiln's tables, the operations engine's among them, share its prefix.
  const prefix = table("x").slice(0, -1)
  const tables = new Map<string, Array<{ name: string; json: boolean }>>()
  // Kinds, read beside each row to tell what its IDs are.
  const kinds = new Map<string, Array<string>>()
  for (const column of columns) {
    if (!column.table_name.startsWith(prefix)) continue
    if (skippedTables.has(column.table_name)) continue
    if (column.data_type.toLowerCase() === "enum") {
      let list = kinds.get(column.table_name)
      if (!list) kinds.set(column.table_name, (list = []))
      list.push(column.column_name)
      continue
    }
    if (!textTypes.has(column.data_type.toLowerCase())) continue
    if (keptColumns.has(`${column.table_name}.${column.column_name}`)) continue
    if (secretColumn.test(column.column_name)) continue
    let list = tables.get(column.table_name)
    if (!list) tables.set(column.table_name, (list = []))
    list.push({
      json: column.data_type.toLowerCase() === "json",
      name: column.column_name,
    })
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
    rewritten += yield* rewriteTable(
      sql,
      mapping,
      name,
      primaryKey,
      textColumns,
      kinds.get(name) ?? []
    )
  }
  yield* Effect.logInfo("Instance ID migration rewrote records", { rewritten })
})

// Anything that could hold an old ID: 40 hex characters, or 43 base64url.
const LEGACY_SHAPE = "[a-f0-9]{40}|[A-Za-z0-9_-]{43}"

const rewriteTable = Effect.fn("migration.instanceIds.rewriteTable")(function* (
  sql: Sql,
  mapping: Mapping,
  name: string,
  primaryKey: ReadonlyArray<string>,
  textColumns: ReadonlyArray<{ name: string; json: boolean }>,
  kindColumns: ReadonlyArray<string>
) {
  const read = (column: { name: string; json: boolean }) =>
    `CAST(\`${column.name}\` AS CHAR)`
  const names = new Set(textColumns.map((column) => column.name))
  // The Relay each column's game servers are on: a column of its own where
  // the table declares one, as a server migration's source and destination
  // do, else the row's `relay_id`.
  const relayColumnOf = (column: string): string | null => {
    const declared = instanceIdColumns.find(
      (source) =>
        table(source.table) === name &&
        source.column === column &&
        source.relayColumn !== undefined
    )?.relayColumn
    if (declared === null) return null
    if (declared && names.has(declared)) return declared
    return names.has("relay_id") ? "relay_id" : null
  }
  // Primary keys first, read once, so rewriting a key never moves a row
  // past the next page.
  const candidates = yield* sql.unsafe<Record<string, unknown>>(
    `SELECT ${primaryKey.map((key) => `\`${key}\``).join(", ")}
FROM \`${name}\`
WHERE ${textColumns.map((column) => `${read(column)} REGEXP '${LEGACY_SHAPE}'`).join(" OR ")}`
  )
  let changed = 0
  for (let start = 0; start < candidates.length; start += 500) {
    const page = candidates.slice(start, start + 500)
    const rows = yield* sql.unsafe<Record<string, string | null>>(
      `SELECT ${primaryKey.map((key) => `\`${key}\` AS \`pk_${key}\``).join(", ")},
  ${[
    ...textColumns.map((column) => `${read(column)} AS \`${column.name}\``),
    ...kindColumns.map(
      (column) => `CAST(\`${column}\` AS CHAR) AS \`${column}\``
    ),
  ].join(", ")}
FROM \`${name}\`
WHERE (${primaryKey.map((key) => `\`${key}\``).join(", ")}) IN (${page
        .map(() => `(${primaryKey.map(() => "?").join(", ")})`)
        .join(", ")})`,
      page.flatMap((row) => primaryKey.map((key) => row[key] as never))
    )
    for (const row of rows) {
      const updates: Array<[string, string]> = []
      for (const column of textColumns) {
        const value = row[column.name]
        if (typeof value !== "string" || value.length === 0) continue
        const relayColumn = relayColumnOf(column.name)
        const relay = relayColumn ? row[relayColumn] : null
        const rewriter =
          relay && mapping.relays.has(relay)
            ? mapping.forRelay(relay)
            : mapping.global
        const next = rewriteValue(
          name,
          column.name,
          value,
          row,
          mapping,
          rewriter
        )
        if (next !== value) updates.push([column.name, next])
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

function rewriteValue(
  name: string,
  column: string,
  value: string,
  row: Record<string, string | null>,
  mapping: Mapping,
  rewriter: LegacyIdRewriter
): string {
  // A Relay's host files were a file root named by its fingerprint; they're
  // `relay:<id>` now, since a bare ID is a game server's root.
  const relayRoot = mapping.relays.get(value)
  if (relayRoot !== undefined) {
    if (name === table("file_activity") && column === "root_id") {
      return `relay:${relayRoot}`
    }
    if (
      name === table("authorization_delivery") &&
      column === "scope_id" &&
      row.scope_kind === "instance"
    ) {
      return `relay:${relayRoot}`
    }
  }
  let text = value
  for (const [fingerprint, id] of mapping.relays) {
    if (!text.includes(fingerprint)) continue
    text = text.replaceAll(
      `file-activity:${fingerprint}/${fingerprint}`,
      `file-activity:${id}/relay:${id}`
    )
  }
  // A lock key names its resource's Relay itself (`instance:<relay>/<id>`),
  // so its game server takes that Relay's new ID, whichever row it's in.
  text = text.replace(
    /\b(instance|app|database|volume):([A-Za-z0-9_-]{43})\/([a-f0-9]{40})(?![a-f0-9])/gu,
    (match, kind: string, fingerprint: string, id: string) =>
      mapping.relays.has(fingerprint)
        ? `${kind}:${fingerprint}/${mapping.forRelay(fingerprint).rewrite(id)}`
        : match
  )
  // So does an operation's input, as `{ relayId, instanceId }` objects such
  // as a server migration's source and destination.
  if (text.startsWith("{") || text.startsWith("[")) {
    const scoped = scopedJson(text, mapping)
    if (scoped !== null) text = scoped
  }
  return rewriter.rewrite(text)
}

const SCOPED_KEYS = ["id", "instanceId", "resourceId", "targetId"]

function scopedJson(text: string, mapping: Mapping): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  let changed = false
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (value === null || typeof value !== "object") return value
    const object = value as Record<string, unknown>
    const relay = object.relayId
    const rewriter =
      typeof relay === "string" && mapping.relays.has(relay)
        ? mapping.forRelay(relay)
        : null
    const next: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(object)) {
      if (
        rewriter &&
        SCOPED_KEYS.includes(key) &&
        typeof field === "string" &&
        isLegacyResourceId(field)
      ) {
        const rewritten = rewriter.rewrite(field)
        if (rewritten !== field) changed = true
        next[key] = rewritten
      } else {
        next[key] = visit(field)
      }
    }
    return next
  }
  const result = visit(parsed)
  return changed ? JSON.stringify(result) : null
}

const APP_CONFIG_PURPOSE = "kiln-app-config"

const rewriteAppConfigs = Effect.fn("migration.instanceIds.appConfigs")(
  function* (sql: Sql, mapping: Mapping) {
    if (mapping.global.size === 0) return
    const apps = yield* sql.unsafe<{
      app_id: string
      config_ciphertext: string
    }>(`SELECT app_id, config_ciphertext FROM \`${table("app")}\``)
    if (apps.length === 0) return
    const secrets = betterAuthSecrets()
    for (const app of apps) {
      const decrypted = decryptWithKeyring(
        app.config_ciphertext,
        secrets,
        APP_CONFIG_PURPOSE
      )
      const next = mapping.global.rewrite(decrypted.plaintext)
      if (next === decrypted.plaintext) continue
      yield* sql.unsafe(
        `UPDATE \`${table("app")}\` SET config_ciphertext = ? WHERE app_id = ?`,
        [encryptWithKeyring(next, secrets, APP_CONFIG_PURPOSE), app.app_id]
      )
    }
  }
)

// --- 4. Column widths --------------------------------------------------------

// The columns that hold nothing but an instance ID. Columns that also hold
// volume IDs or other keys keep their width.
const idColumns: ReadonlyArray<readonly [string, string]> = [
  ...relayIdColumns.map(({ table, column }) => [table, column] as const),
  ["instance", "instance_id"],
  ["instance_domain", "instance_id"],
  ["instance_domain_opt_out", "instance_id"],
  ["instance_post_provision", "instance_id"],
  ["file_activity", "instance_id"],
  ["invitation", "instance_id"],
  ["invitation", "database_id"],
  ["server_migration", "source_instance_id"],
  ["server_migration", "destination_instance_id"],
  ["app", "app_id"],
  ["app_deployment", "app_id"],
  ["app_github_source", "app_id"],
  ["app_image_update", "app_id"],
  ["app_image_update_attempt", "app_id"],
  ["file_activity", "app_id"],
  ["database", "database_id"],
  ["tailscale_network", "id"],
  ["tailscale_network_deployment", "network_id"],
]

interface ForeignKey {
  readonly table: string
  readonly name: string
  readonly columns: ReadonlyArray<string>
  readonly references: string
  readonly referencedColumns: ReadonlyArray<string>
}

// Every foreign key on those columns, as the migrations before made them;
// they're dropped while the columns change and made again after.
const foreignKeys: ReadonlyArray<ForeignKey> = [
  ...(
    [
      "app",
      "authorization_delivery",
      "database",
      "file_activity",
      "github_sync",
      "instance",
      "permission_preset",
      "relay_database_connection_import",
      "resource_deletion",
      "schedule_deployment",
      "schedule_run",
      "schedule_target",
      "security_alert",
      "security_sbom",
      "security_target",
    ] as const
  ).map((name) => ({
    columns: ["relay_id"],
    name: "relay_fk",
    referencedColumns: ["id"],
    references: "relay",
    table: name,
  })),
  ...(
    [
      "app_deployment",
      "app_github_source",
      "app_image_update",
      "app_image_update_attempt",
      "file_activity",
    ] as const
  ).map((name) => ({
    columns: ["app_id"],
    name: "app_fk",
    referencedColumns: ["app_id"],
    references: "app",
    table: name,
  })),
  ...(["file_activity", "instance_post_provision"] as const).map((name) => ({
    columns: ["relay_id", "instance_id"],
    name: "instance_fk",
    referencedColumns: ["relay_id", "instance_id"],
    references: "instance",
    table: name,
  })),
  {
    columns: ["relay_id", "sbom_key"],
    name: "sbom_fk",
    referencedColumns: ["relay_id", "sbom_key"],
    references: "security_sbom",
    table: "security_finding",
  },
  {
    columns: ["network_id"],
    name: "network_fk",
    referencedColumns: ["id"],
    references: "tailscale_network",
    table: "tailscale_network_deployment",
  },
]

const shrinkIdColumns = Effect.fn("migration.instanceIds.shrink")(function* (
  sql: Sql
) {
  const pending: Array<{
    table: string
    column: string
    nullable: boolean
    varying: boolean
  }> = []
  for (const [base, column] of idColumns) {
    const name = table(base)
    const rows = yield* sql.unsafe<{
      column_type: string
      collation_name: string | null
      is_nullable: string
      data_type: string
    }>(
      `SELECT column_type AS column_type, collation_name AS collation_name,
  is_nullable AS is_nullable, data_type AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [name, column]
    )
    const current = rows[0]
    if (!current) continue
    const varying = current.data_type.toLowerCase() === "varchar"
    const target = varying ? "varchar(12)" : "char(12)"
    if (
      current.column_type.toLowerCase() === target &&
      current.collation_name === "ascii_bin"
    ) {
      continue
    }
    pending.push({
      column,
      nullable: current.is_nullable === "YES",
      table: name,
      // A user's icon has no Relay: its `relay_id` is empty.
      varying,
    })
  }
  if (pending.length > 0) {
    for (const key of foreignKeys) {
      const name = table(key.table)
      const constraint = `${name}_${key.name}`
      if (yield* constraintExists(sql, name, constraint)) {
        yield* sql.unsafe(
          `ALTER TABLE \`${name}\` DROP FOREIGN KEY \`${constraint}\``
        )
      }
    }
    const byTable = new Map<string, typeof pending>()
    for (const column of pending) {
      let list = byTable.get(column.table)
      if (!list) byTable.set(column.table, (list = []))
      list.push(column)
    }
    for (const [name, columns] of byTable) {
      yield* sql.unsafe(
        `ALTER TABLE \`${name}\` ${columns
          .map(
            (column) =>
              `MODIFY \`${column.column}\` ${column.varying ? "varchar(12)" : "char(12)"} CHARACTER SET ascii COLLATE ascii_bin ${column.nullable ? "NULL" : "NOT NULL"}`
          )
          .join(", ")}`
      )
    }
  }
  for (const key of foreignKeys) {
    const name = table(key.table)
    const constraint = `${name}_${key.name}`
    if (!(yield* tableExists(sql, name))) continue
    if (yield* constraintExists(sql, name, constraint)) continue
    yield* sql.unsafe(`ALTER TABLE \`${name}\`
  ADD CONSTRAINT \`${constraint}\` FOREIGN KEY (${key.columns.map((column) => `\`${column}\``).join(", ")})
  REFERENCES \`${table(key.references)}\` (${key.referencedColumns.map((column) => `\`${column}\``).join(", ")})
  ON DELETE CASCADE`)
  }
})

// --- Schema reads -----------------------------------------------------------

function columnExists(sql: Sql, name: string, column: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [name, column]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function tableExists(sql: Sql, name: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = ?`,
      [name]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}

function constraintExists(sql: Sql, name: string, constraint: string) {
  return sql
    .unsafe<{ found: number }>(
      `SELECT COUNT(*) AS found FROM information_schema.table_constraints
WHERE table_schema = DATABASE() AND table_name = ?
  AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`,
      [name, constraint]
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0))
}
