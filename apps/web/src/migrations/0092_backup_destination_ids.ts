import {
  isInstanceId,
  isLegacyBackupDestinationId,
  migratedBackupDestinationId,
} from "@workspace/contracts"
import { Effect, Result } from "effect"
import { SqlClient } from "effect/sql"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

/**
 * A backup destination takes a 12-character ID from the instance
 * directory, as an instance does, in place of its UUID. No destination then
 * shares an ID with an instance, a Relay least of all: a Relay's own disk
 * is a destination under the Relay's ID.
 *
 * 1. The directory learns the kind, and a destination says which kind of
 *    storage it is (`s3`, the only one so far).
 * 2. Each old ID gets its new one, a hash of the old
 *    (`migratedBackupDestinationId`), which every Relay computes for itself
 *    for the schedules and tasks it stored. It is reserved beside the old
 *    one; one the directory already gave to something else stops the
 *    migration here.
 * 3. One transaction then rewrites the old ID wherever a record names it:
 *    the destination, its backups, copies and repositories, schedules'
 *    steps, operations, lock keys. A UUID turns up nowhere by chance, so
 *    it is replaced wherever it appears, except in a path in a bucket. The
 *    destination's keys are encrypted bound to its ID, so they are
 *    encrypted again under the new one. Hearth puts no destination's ID in
 *    an object's path, but a folder someone chose may hold one, and the
 *    objects there don't move: paths stay as they are.
 *
 * Each step finds what's left to do, so running it again after a crash
 * carries on where it stopped.
 */
export const backupDestinationIds: Migration = {
  id: 92,
  name: "backup_destination_ids",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* prepareSchema(sql)
    const mapping = yield* reserveNewIds(sql)
    if (mapping.size === 0) return
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 0")
        yield* reencryptKeys(sql, mapping)
        yield* rewriteRecords(sql, mapping)
        yield* sql.unsafe("SET FOREIGN_KEY_CHECKS = 1")
      })
    )
    yield* Effect.logInfo("Backup destinations took their new IDs", {
      destinations: mapping.size,
    })
  }),
}

const table = databaseTableName

type Sql = SqlClient.SqlClient

/** Old ID to new. */
type Mapping = ReadonlyMap<string, string>

const prepareSchema = Effect.fn("migration.destinationIds.schema")(function* (
  sql: Sql
) {
  const directory = table("instance_id")
  const [kind] = yield* sql.unsafe<{ columnType: string }>(
    `SELECT column_type AS columnType FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'kind'`,
    [directory]
  )
  if (kind && !kind.columnType.includes("'destination'")) {
    yield* sql.unsafe(`ALTER TABLE \`${directory}\`
  MODIFY \`kind\` enum('relay','server','app','database','tailscale','group','tunnel','gateway','destination') NOT NULL`)
  }
  const storage = table("backup_storage")
  const [storageKind] = yield* sql.unsafe<{ found: number }>(
    `SELECT COUNT(*) AS found FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'kind'`,
    [storage]
  )
  if (Number(storageKind?.found ?? 0) === 0) {
    yield* sql.unsafe(`ALTER TABLE \`${storage}\`
  ADD COLUMN \`kind\` enum('s3') NOT NULL DEFAULT 's3' AFTER \`id\``)
  }
})

const reserveNewIds = Effect.fn("migration.destinationIds.reserve")(function* (
  sql: Sql
) {
  const directory = table("instance_id")
  const destinations = yield* sql.unsafe<{ id: string }>(
    `SELECT id FROM \`${table("backup_storage")}\``
  )
  const mapping = new Map<string, string>()
  const now = Date.now()
  for (const { id } of destinations) {
    if (isInstanceId(id)) {
      // Already moved, or made since: only its reservation may be missing.
      yield* sql.unsafe(
        `INSERT IGNORE INTO \`${directory}\` (id, kind, created_at)
VALUES (?, 'destination', ?)`,
        [id, now]
      )
      continue
    }
    if (!isLegacyBackupDestinationId(id)) {
      return yield* Effect.fail(
        new Error(`Backup destination ${id} has an ID of neither format`)
      )
    }
    const next = yield* Effect.promise(() => migratedBackupDestinationId(id))
    yield* sql.unsafe(
      `INSERT IGNORE INTO \`${directory}\`
  (id, kind, legacy_id, created_at)
VALUES (?, 'destination', ?, ?)`,
      [next, id, now]
    )
    const [holder] = yield* sql.unsafe<{
      kind: string
      legacy_id: string | null
    }>(`SELECT kind, legacy_id FROM \`${directory}\` WHERE id = ?`, [next])
    if (holder?.kind !== "destination" || holder.legacy_id !== id) {
      return yield* Effect.fail(
        new Error(
          `Backup destination ${id} would take the ID ${next}, which already belongs to something else`
        )
      )
    }
    mapping.set(id, next)
  }
  return mapping as Mapping
})

// A destination's keys are bound to its ID as they are encrypted
// (`credentialPurpose` in the storage module, as it was when this ran).
const purpose = (id: string, field: string) =>
  `kiln-backup-storage:${id}:${field}`

const reencryptKeys = Effect.fn("migration.destinationIds.keys")(function* (
  sql: Sql,
  mapping: Mapping
) {
  const storage = table("backup_storage")
  const rows = yield* sql.unsafe<{
    access_key_id_ciphertext: string
    id: string
    secret_access_key_ciphertext: string
  }>(
    `SELECT id, access_key_id_ciphertext, secret_access_key_ciphertext
FROM \`${storage}\``
  )
  const secrets = betterAuthSecrets()
  for (const row of rows) {
    const next = mapping.get(row.id)
    if (!next) continue
    const moved = Result.try(() => ({
      accessKeyId: encryptWithKeyring(
        decryptWithKeyring(
          row.access_key_id_ciphertext,
          secrets,
          purpose(row.id, "access-key-id")
        ).plaintext,
        secrets,
        purpose(next, "access-key-id")
      ),
      secretAccessKey: encryptWithKeyring(
        decryptWithKeyring(
          row.secret_access_key_ciphertext,
          secrets,
          purpose(row.id, "secret-access-key")
        ).plaintext,
        secrets,
        purpose(next, "secret-access-key")
      ),
    }))
    if (Result.isFailure(moved)) {
      // Keys that can't be read now couldn't be before either: the
      // destination was already unusable, and stays so until its keys are
      // entered again. It mustn't keep Hearth from starting.
      yield* Effect.logWarning(
        "A backup destination's keys couldn't be read, so they weren't moved to its new ID; enter them again",
        { destinationId: next }
      )
      continue
    }
    yield* sql.unsafe(
      `UPDATE \`${storage}\`
SET access_key_id_ciphertext = ?, secret_access_key_ciphertext = ?
WHERE id = ?`,
      [moved.success.accessKeyId, moved.success.secretAccessKey, row.id]
    )
  }
})

// Tables with nothing that names a destination, or that this migration
// writes itself.
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
const secretColumn = /ciphertext|secret|password|token|private_key/iu
// Where something is in a bucket: rewriting one would point a record at an
// object that isn't there.
const pathColumn = /^object_(key|prefix)$/u
const textTypes = new Set([
  "char",
  "varchar",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "json",
])

const rewriteRecords = Effect.fn("migration.destinationIds.rewrite")(function* (
  sql: Sql,
  mapping: Mapping
) {
  const columns = yield* sql.unsafe<{
    column_name: string
    data_type: string
    table_name: string
  }>(`SELECT table_name AS table_name, column_name AS column_name,
  data_type AS data_type
FROM information_schema.columns
WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position`)
  // Kiln's tables, the operations engine's among them, share its prefix.
  const prefix = table("x").slice(0, -1)
  const tables = new Map<string, Array<string>>()
  for (const column of columns) {
    if (!column.table_name.startsWith(prefix)) continue
    if (skippedTables.has(column.table_name)) continue
    if (!textTypes.has(column.data_type.toLowerCase())) continue
    if (secretColumn.test(column.column_name)) continue
    if (pathColumn.test(column.column_name)) continue
    let list = tables.get(column.table_name)
    if (!list) tables.set(column.table_name, (list = []))
    list.push(column.column_name)
  }
  for (const [from, to] of mapping) {
    for (const [name, textColumns] of tables) {
      yield* sql.unsafe(
        `UPDATE \`${name}\`
SET ${textColumns.map((column) => `\`${column}\` = REPLACE(\`${column}\`, ?, ?)`).join(", ")}
WHERE ${textColumns.map((column) => `CAST(\`${column}\` AS CHAR) LIKE ?`).join(" OR ")}`,
        [
          ...textColumns.flatMap(() => [from, to]),
          ...textColumns.map(() => `%${from}%`),
        ]
      )
    }
  }
})
