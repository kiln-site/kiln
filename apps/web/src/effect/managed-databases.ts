import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { DatabaseEngine } from "@workspace/contracts"
import {
  databaseEngineSchema,
  databaseEngineSupportsLogicalBackups,
} from "@workspace/contracts"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

const DATABASE_PASSWORD_PURPOSE = "kiln-managed-database-password"

interface ManagedDatabaseRow extends RowDataPacket {
  brick_id: string
  created_at: number
  created_by: string
  database_id: string
  database_name: string
  engine: string
  image: string | null
  internal_port: number
  name: string
  relay_id: string
}

interface ManagedDatabaseCredentialRow extends ManagedDatabaseRow {
  password_ciphertext: string
  username: string
}

interface ManagedDatabaseIdRow extends RowDataPacket {
  database_id: string
}

interface ManagedDatabaseDirectoryRow extends RowDataPacket {
  brick_id: string
  created_at: number
  database_name: string
  database_id: string
  engine: string
  image: string | null
  internal_port: number
  name: string
  relay_id: string
}

export interface ManagedDatabaseRecord {
  /** The Brick it runs, by its ID. */
  brickId: string
  createdAt: string
  createdBy: string
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
  /**
   * The image its Brick resolved to. Its engine's name, with no tag, from
   * when it is recorded until its Relay says what it runs.
   */
  image: string
  /** The port it listens on, as its Brick says. */
  internalPort: number
  name: string
  relayId: string
}

export interface ManagedDatabaseDirectoryRecord {
  databaseId: string
  name: string
  relayId: string
  supportsImportExport: boolean
}

export const listManagedDatabaseRecordsEffect = Effect.fn(
  "managedDatabases.list"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<ManagedDatabaseRow>(
    "managed_databases_list",
    `SELECT database_id, relay_id, name, engine, brick_id, image,
            internal_port, database_name, created_by, created_at
       FROM ${databaseTable("database")}
      ORDER BY name ASC, created_at ASC`
  )
  return rows.map(toRecord)
})

export const listManagedDatabaseDirectoryEffect = Effect.fn(
  "managedDatabases.directory"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<ManagedDatabaseDirectoryRow>(
    "managed_databases_directory",
    `SELECT database_id, relay_id, name, engine, brick_id, image,
            internal_port, database_name, created_at
       FROM ${databaseTable("database")}
      ORDER BY name ASC, created_at ASC`
  )
  return rows.map((row) => {
    const engine = databaseEngineSchema.parse(row.engine)
    return {
      brickId: row.brick_id,
      createdAt: new Date(row.created_at).toISOString(),
      databaseId: row.database_id,
      databaseName: row.database_name,
      engine,
      image: row.image ?? engine,
      internalPort: Number(row.internal_port),
      name: row.name,
      relayId: row.relay_id,
      supportsImportExport: databaseEngineSupportsLogicalBackups(engine),
    }
  })
})

export const managedDatabaseNameExistsEffect = Effect.fn(
  "managedDatabases.nameExists"
)(function* (relayId: string, name: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<ManagedDatabaseIdRow>(
    "managed_database_name_exists",
    `SELECT database_id
       FROM ${databaseTable("database")}
      WHERE relay_id = ? AND name = ?
      LIMIT 1`,
    [relayId, name]
  )
  return rows.length > 0
})

export const createManagedDatabaseRecordEffect = Effect.fn(
  "managedDatabases.create"
)(function* (input: {
  /** The Brick it runs, and where that came from. */
  brickId: string
  brickSource: string
  createdBy: string
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
  /** The port its Brick says it listens on. */
  internalPort: number
  name: string
  password: string
  relayId: string
  username: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const ciphertext = yield* encryptPassword(input.password)
  yield* database.execute(
    "managed_databases_create",
    `INSERT INTO ${databaseTable("database")}
      (database_id, relay_id, name, engine, brick_id, brick_source,
       internal_port, database_name, username, password_ciphertext,
       created_by, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.databaseId,
      input.relayId,
      input.name,
      input.engine,
      input.brickId,
      input.brickSource,
      input.internalPort,
      input.databaseName,
      input.username,
      ciphertext,
      input.createdBy,
      input.createdBy,
      now,
      now,
    ]
  )
})

/**
 * Records the image a database's Brick resolved to, once its Relay has
 * worked that out from its answers.
 */
export const setManagedDatabaseImageEffect = Effect.fn(
  "managedDatabases.setImage"
)(function* (relayId: string, databaseId: string, image: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "managed_database_set_image",
    `UPDATE ${databaseTable("database")}
        SET image = ?, updated_at = ?
      WHERE relay_id = ? AND database_id = ?`,
    [image, now, relayId, databaseId]
  )
})

export const loadManagedDatabaseCredentialEffect = Effect.fn(
  "managedDatabases.credential"
)(function* (relayId: string, databaseId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<ManagedDatabaseCredentialRow>(
    "managed_database_credential",
    `SELECT database_id, relay_id, name, engine, brick_id, image,
            internal_port, database_name, username, password_ciphertext,
            created_by, created_at
       FROM ${databaseTable("database")}
      WHERE relay_id = ? AND database_id = ?
      LIMIT 1`,
    [relayId, databaseId]
  )
  const row = rows.at(0)
  if (!row) return null
  const decrypted = yield* decryptPassword(row.password_ciphertext)
  if (decrypted.needsRotation) {
    const rotated = yield* encryptPassword(decrypted.plaintext)
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "managed_database_credential_reencrypt",
      `UPDATE ${databaseTable("database")}
          SET password_ciphertext = ?, updated_at = ?
        WHERE relay_id = ? AND database_id = ? AND password_ciphertext = ?`,
      [rotated, now, relayId, databaseId, row.password_ciphertext]
    )
  }
  return {
    ...toRecord(row),
    password: decrypted.plaintext,
    username: row.username,
  }
})

export const rotateManagedDatabaseCredentialEffect = Effect.fn(
  "managedDatabases.rotateCredential"
)(function* (relayId: string, databaseId: string, password: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const ciphertext = yield* encryptPassword(password)
  const result = yield* database.execute(
    "managed_database_credential_rotate",
    `UPDATE ${databaseTable("database")}
        SET password_ciphertext = ?, updated_at = ?
      WHERE relay_id = ? AND database_id = ?`,
    [ciphertext, now, relayId, databaseId]
  )
  if (result.affectedRows !== 1) {
    return yield* Effect.fail(new Error("Database record not found"))
  }
})

// Hearth keeps the name; the Relay's container label keeps the one it was
// created with, for recovery.
export const renameManagedDatabaseRecordEffect = Effect.fn(
  "managedDatabases.rename"
)(function* (relayId: string, databaseId: string, name: string) {
  const database = yield* Database
  const taken = yield* database.queryRows<ManagedDatabaseIdRow>(
    "managed_database_rename_conflict",
    `SELECT database_id
       FROM ${databaseTable("database")}
      WHERE relay_id = ? AND name = ? AND database_id <> ?
      LIMIT 1`,
    [relayId, name, databaseId]
  )
  if (taken.length > 0) {
    return yield* Effect.fail(
      new Error(`A database named "${name}" already exists on this Relay`)
    )
  }
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "managed_database_rename",
    `UPDATE ${databaseTable("database")}
        SET name = ?, updated_at = ?
      WHERE relay_id = ? AND database_id = ?`,
    [name, now, relayId, databaseId]
  )
  if (result.affectedRows !== 1) {
    return yield* Effect.fail(new Error("Database record not found"))
  }
})

// Only the record. What else points at a deleted database goes with
// cleanUpDeletedResourceEffect.
export const deleteManagedDatabaseRecordEffect = Effect.fn(
  "managedDatabases.delete"
)(function* (relayId: string, databaseId: string) {
  const database = yield* Database
  yield* database.execute(
    "managed_database_delete",
    `DELETE FROM ${databaseTable("database")}
      WHERE relay_id = ? AND database_id = ?`,
    [relayId, databaseId]
  )
})

function toRecord(row: ManagedDatabaseRow): ManagedDatabaseRecord {
  const engine = databaseEngineSchema.parse(row.engine)
  return {
    brickId: row.brick_id,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
    databaseId: row.database_id,
    databaseName: row.database_name,
    engine,
    image: row.image ?? engine,
    internalPort: Number(row.internal_port),
    name: row.name,
    relayId: row.relay_id,
  }
}

function encryptPassword(password: string) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        password,
        betterAuthSecrets(),
        DATABASE_PASSWORD_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "encrypt_managed_database_password",
        cause,
      }),
  })
}

function decryptPassword(ciphertext: string) {
  return Effect.try({
    try: () =>
      decryptWithKeyring(
        ciphertext,
        betterAuthSecrets(),
        DATABASE_PASSWORD_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "decrypt_managed_database_password",
        cause,
      }),
  })
}
