import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

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
  created_at: Date
  created_by: string
  database_id: string
  database_name: string
  engine: string
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
  database_id: string
  engine: string
  name: string
  relay_id: string
}

export interface ManagedDatabaseRecord {
  createdAt: string
  createdBy: string
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
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
    `SELECT database_id, relay_id, name, engine, database_name, created_by,
            created_at
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
    `SELECT database_id, relay_id, name, engine
       FROM ${databaseTable("database")}
      ORDER BY name ASC, created_at ASC`
  )
  return rows.map((row) => {
    const engine = databaseEngineSchema.parse(row.engine)
    return {
      databaseId: row.database_id,
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
  createdBy: string
  databaseId: string
  databaseName: string
  engine: DatabaseEngine
  name: string
  password: string
  relayId: string
  username: string
}) {
  const database = yield* Database
  const ciphertext = yield* encryptPassword(input.password)
  yield* database.execute(
    "managed_databases_create",
    `INSERT INTO ${databaseTable("database")}
      (database_id, relay_id, name, engine, database_name, username,
       password_ciphertext, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.databaseId,
      input.relayId,
      input.name,
      input.engine,
      input.databaseName,
      input.username,
      ciphertext,
      input.createdBy,
    ]
  )
})

export const loadManagedDatabaseCredentialEffect = Effect.fn(
  "managedDatabases.credential"
)(function* (relayId: string, databaseId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<ManagedDatabaseCredentialRow>(
    "managed_database_credential",
    `SELECT database_id, relay_id, name, engine, database_name, username,
            password_ciphertext, created_by, created_at
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
    yield* database.execute(
      "managed_database_credential_reencrypt",
      `UPDATE ${databaseTable("database")}
          SET password_ciphertext = ?
        WHERE relay_id = ? AND database_id = ? AND password_ciphertext = ?`,
      [rotated, relayId, databaseId, row.password_ciphertext]
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
  const ciphertext = yield* encryptPassword(password)
  const result = yield* database.execute(
    "managed_database_credential_rotate",
    `UPDATE ${databaseTable("database")}
        SET password_ciphertext = ?
      WHERE relay_id = ? AND database_id = ?`,
    [ciphertext, relayId, databaseId]
  )
  if (result.affectedRows !== 1) {
    return yield* Effect.fail(new Error("Database record not found"))
  }
})

export const deleteManagedDatabaseRecordEffect = Effect.fn(
  "managedDatabases.delete"
)(function* (relayId: string, databaseId: string) {
  const database = yield* Database
  yield* database.transaction("managed_database_delete", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("invitation")}
          WHERE relay_id = ? AND database_id = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP(3)`,
        [relayId, databaseId]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("database")}
          WHERE relay_id = ? AND database_id = ?`,
        [relayId, databaseId]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("access_grant")}
          WHERE relay_id = ? AND resource_type = 'database' AND resource_id = ?`,
        [relayId, databaseId]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("permission_preset")}
          WHERE relay_id = ? AND resource_type = 'database' AND resource_id = ?`,
        [relayId, databaseId]
      )
    })
  )
})

function toRecord(row: ManagedDatabaseRow): ManagedDatabaseRecord {
  return {
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    databaseId: row.database_id,
    databaseName: row.database_name,
    engine: databaseEngineSchema.parse(row.engine),
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
