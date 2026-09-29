import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Result } from "effect"

import { decryptWithKeyring, encryptWithKeyring } from "../../../../keyring.mjs"
import { Database } from "@/effect/database"
import { BackupStorageError, CredentialError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"
import {
  deleteS3BackupPrefix,
  type S3BackupCredential,
} from "@/backups/destinations/s3/client"

interface BackupStoragePublicRow extends RowDataPacket {
  allow_private_network: boolean | number
  bucket: string
  created_at: number
  deleting: boolean | number
  enabled: boolean | number
  endpoint: string
  force_path_style: boolean | number
  id: string
  last_error: string | null
  last_verified_at: number | null
  name: string
  object_prefix: string
  owner_user_id: string | null
  region: string
}

interface BackupStorageRow extends BackupStoragePublicRow {
  access_key_id_ciphertext: string
  secret_access_key_ciphertext: string
}

interface BackupReferenceCountRow extends RowDataPacket {
  reference_count: number | string
}

interface BackupStorageIdentityRow extends RowDataPacket {
  bucket: string
  deleting: boolean | number
  endpoint: string
  force_path_style: boolean | number
  id: string
  object_prefix: string
  region: string
  owner_user_id: string | null
}

export interface BackupStorageRecord {
  allowPrivateNetwork: boolean
  bucket: string
  createdAt: string
  deleting: boolean
  enabled: boolean
  endpoint: string
  forcePathStyle: boolean
  id: string
  lastError: string | null
  lastVerifiedAt: string | null
  name: string
  objectPrefix: string
  ownerUserId: string | null
  region: string
}

export interface BackupStorageCredential
  extends BackupStorageRecord, S3BackupCredential {}

export const listBackupStorageEffect = Effect.fn("backupStorage.list")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<BackupStoragePublicRow>(
      "backup_storage_list",
      `${backupStoragePublicSelect}
       ORDER BY owner_user_id IS NOT NULL, name ASC, id ASC`
    )
    return rows.map(toRecord)
  }
)

export const loadBackupStorageEffect = Effect.fn("backupStorage.load")(
  function* (storageId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<BackupStoragePublicRow>(
      "backup_storage_load",
      `${backupStoragePublicSelect}
        WHERE id = ?
        LIMIT 1`,
      [storageId]
    )
    return rows[0] ? toRecord(rows[0]) : null
  }
)

export const loadBackupStorageCredentialEffect = Effect.fn(
  "backupStorage.loadCredential"
)(function* (storageId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<BackupStorageRow>(
    "backup_storage_credential",
    `${backupStorageSelect}
      WHERE id = ?
      LIMIT 1`,
    [storageId]
  )
  const row = rows[0]
  if (!row) return null
  const accessKey = yield* decryptCredential(
    row.access_key_id_ciphertext,
    storageId,
    "access-key-id"
  )
  const secretKey = yield* decryptCredential(
    row.secret_access_key_ciphertext,
    storageId,
    "secret-access-key"
  )
  if (accessKey.needsRotation || secretKey.needsRotation) {
    const encryptedAccessKey = yield* encryptCredential(
      accessKey.plaintext,
      storageId,
      "access-key-id"
    )
    const encryptedSecretKey = yield* encryptCredential(
      secretKey.plaintext,
      storageId,
      "secret-access-key"
    )
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "backup_storage_rotate_credentials",
      `UPDATE ${databaseTable("backup_storage")}
          SET access_key_id_ciphertext = ?, secret_access_key_ciphertext = ?,
              updated_at = ?
        WHERE id = ?
          AND access_key_id_ciphertext = ?
          AND secret_access_key_ciphertext = ?`,
      [
        encryptedAccessKey,
        encryptedSecretKey,
        now,
        storageId,
        row.access_key_id_ciphertext,
        row.secret_access_key_ciphertext,
      ]
    )
  }
  return {
    ...toRecord(row),
    accessKeyId: accessKey.plaintext,
    secretAccessKey: secretKey.plaintext,
  } satisfies BackupStorageCredential
})

export const saveBackupStorageEffect = Effect.fn("backupStorage.save")(
  function* (input: {
    accessKeyId: string
    allowPrivateNetwork: boolean
    bucket: string
    enabled: boolean
    endpoint: string
    forcePathStyle: boolean
    id: string
    name: string
    objectPrefix: string
    ownerUserId: string | null
    region: string
    secretAccessKey: string
  }) {
    const database = yield* Database
    const accessKeyCiphertext = yield* encryptCredential(
      input.accessKeyId,
      input.id,
      "access-key-id"
    )
    const secretKeyCiphertext = yield* encryptCredential(
      input.secretAccessKey,
      input.id,
      "secret-access-key"
    )
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("backup_storage_save", (transaction) =>
      Effect.gen(function* () {
        const existingRows =
          yield* transaction.queryRows<BackupStorageIdentityRow>(
            `SELECT id, owner_user_id, endpoint, region, bucket,
                    object_prefix, force_path_style, deleting
               FROM ${databaseTable("backup_storage")}
              WHERE id = ?
              FOR UPDATE`,
            [input.id]
          )
        const existing = existingRows[0]
        if (existing && existing.owner_user_id !== input.ownerUserId) {
          return yield* BackupStorageError.make({
            code: "storage_owner_immutable",
            operation: "storage.save",
            reason: "Backup destination ownership cannot be changed",
          })
        }
        const locationChanged =
          existing &&
          (existing.endpoint !== input.endpoint ||
            existing.region !== input.region ||
            existing.bucket !== input.bucket ||
            existing.object_prefix !== input.objectPrefix ||
            Boolean(existing.force_path_style) !== input.forcePathStyle)
        if (existing && Boolean(existing.deleting) && locationChanged) {
          return yield* BackupStorageError.make({
            code: "storage_deleting",
            operation: "storage.save",
            reason:
              "Update credentials to retry the purge. Endpoint, region, bucket, prefix, and addressing cannot change while this destination is being deleted",
          })
        }
        if (locationChanged) {
          const references =
            yield* transaction.queryRows<BackupReferenceCountRow>(
              `SELECT (
                  (SELECT COUNT(*)
                     FROM ${databaseTable("backup")}
                    WHERE storage_id = ? AND status <> 'deleted')
                  +
                  (SELECT COUNT(*)
                     FROM ${databaseTable("backup_artifact")}
                    WHERE storage_id = ? AND status <> 'deleted')
                  +
                  (SELECT COUNT(*)
                     FROM ${databaseTable("backup_repository")}
                    WHERE storage_id = ?)
                ) AS reference_count`,
              [input.id, input.id, input.id]
            )
          if (Number(references[0]?.reference_count ?? 0) > 0) {
            return yield* BackupStorageError.make({
              code: "storage_location_in_use",
              operation: "storage.save",
              reason:
                "Delete this destination's backups before changing its endpoint, region, bucket, prefix, or addressing mode",
            })
          }
        }
        const duplicateRows =
          yield* transaction.queryRows<BackupStorageIdentityRow>(
            `SELECT id, owner_user_id
               FROM ${databaseTable("backup_storage")}
              WHERE owner_user_id <=> ? AND name = ? AND id <> ?
              LIMIT 1
              FOR UPDATE`,
            [input.ownerUserId, input.name, input.id]
          )
        if (duplicateRows[0]) {
          return yield* BackupStorageError.make({
            code: "storage_name_exists",
            operation: "storage.save",
            reason: "A backup destination with this name already exists",
          })
        }
        const values = [
          input.name,
          input.endpoint,
          input.region,
          input.bucket,
          input.objectPrefix,
          input.forcePathStyle,
          input.allowPrivateNetwork,
          accessKeyCiphertext,
          secretKeyCiphertext,
          input.enabled,
        ]
        if (existing) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_storage")}
                SET name = ?, endpoint = ?, region = ?, bucket = ?,
                    object_prefix = ?, force_path_style = ?,
                    allow_private_network = ?, access_key_id_ciphertext = ?,
                    secret_access_key_ciphertext = ?, enabled = ?,
                    last_verified_at = ?, last_error = NULL, updated_at = ?
              WHERE id = ?`,
            [...values, now, now, input.id]
          )
          return
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("backup_storage")}
            (id, owner_user_id, name, endpoint, region, bucket, object_prefix,
             force_path_style, allow_private_network, access_key_id_ciphertext,
             secret_access_key_ciphertext, enabled, last_verified_at, last_error,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [input.id, input.ownerUserId, ...values, now, now, now]
        )
      })
    )
  }
)

export const setBackupPolicyStorageEffect = Effect.fn(
  "backupStorage.setPolicy"
)(function* (input: {
  relayId: string
  storageId: string | null
  targetId: string
  targetKind: "database" | "instance" | "platform"
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("backup_storage_set_policy", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(
        `INSERT IGNORE INTO ${databaseTable("backup_policy")}
          (relay_id, target_kind, target_id, exclude_patterns, created_at,
           updated_at)
         VALUES (?, ?, ?, JSON_ARRAY(), ?, ?)`,
        [input.relayId, input.targetKind, input.targetId, now, now]
      )
      yield* transaction.queryRows<RowDataPacket>(
        `SELECT relay_id
           FROM ${databaseTable("backup_policy")}
          WHERE relay_id = ? AND target_kind = ? AND target_id = ?
          FOR UPDATE`,
        [input.relayId, input.targetKind, input.targetId]
      )
      if (input.storageId) {
        const storage = yield* transaction.queryRows<
          {
            deleting: boolean | number
            enabled: boolean | number
          } & RowDataPacket
        >(
          `SELECT enabled, deleting
             FROM ${databaseTable("backup_storage")}
            WHERE id = ?
            LIMIT 1
            FOR UPDATE`,
          [input.storageId]
        )
        if (
          !storage[0] ||
          !storage[0].enabled ||
          Boolean(storage[0].deleting)
        ) {
          return yield* BackupStorageError.make({
            code: "storage_unavailable",
            operation: "storage.setPolicy",
            reason: "The backup destination is unavailable",
          })
        }
      }
      yield* transaction.execute(
        `UPDATE ${databaseTable("backup_policy")}
            SET storage_id = ?, updated_at = ?
          WHERE relay_id = ? AND target_kind = ? AND target_id = ?`,
        [
          input.storageId,
          now,
          input.relayId,
          input.targetKind,
          input.targetId,
        ]
      )
    })
  )
})

export const deleteBackupStorageEffect = Effect.fn("backupStorage.delete")(
  function* (storageId: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const marked = yield* Effect.result(
      database.transaction("backup_storage_delete_mark", (transaction) =>
        Effect.gen(function* () {
          yield* transaction.queryRows<RowDataPacket>(
            `SELECT relay_id, target_kind, target_id
               FROM ${databaseTable("backup_policy")}
              WHERE storage_id = ?
              ORDER BY relay_id, target_kind, target_id
              FOR UPDATE`,
            [storageId]
          )
          const finalDeletions = yield* transaction.queryRows<RowDataPacket>(
            `SELECT final_delete.backup_id
                 FROM ${databaseTable("backup_final_delete")} final_delete
                 JOIN ${databaseTable("backup_repository")} repository
                   ON repository.relay_id = final_delete.relay_id
                  AND repository.target_kind = 'instance'
                  AND repository.target_id = final_delete.target_id
                WHERE repository.storage_id = ?
                  AND final_delete.status IN ('backing_up', 'deleting')
                LIMIT 1
                FOR UPDATE`,
            [storageId]
          )
          if (finalDeletions[0]?.backup_id) {
            return yield* BackupStorageError.make({
              code: "storage_in_use",
              operation: "storage.delete",
              reason:
                "A server using this destination is being permanently deleted",
            })
          }
          const rows = yield* transaction.queryRows<BackupStorageRow>(
            `${backupStorageSelect}
              WHERE id = ?
              LIMIT 1
              FOR UPDATE`,
            [storageId]
          )
          const existing = rows[0]
          if (!existing) {
            return yield* BackupStorageError.make({
              code: "storage_unavailable",
              operation: "storage.delete",
              reason: "The backup destination is unavailable",
            })
          }
          const accessKey = yield* decryptCredential(
            existing.access_key_id_ciphertext,
            storageId,
            "access-key-id"
          )
          const secretKey = yield* decryptCredential(
            existing.secret_access_key_ciphertext,
            storageId,
            "secret-access-key"
          )
          if (!existing.deleting) {
            const references =
              yield* transaction.queryRows<BackupReferenceCountRow>(
                `SELECT (
                    (SELECT COUNT(*)
                       FROM ${databaseTable("backup")}
                      WHERE storage_id = ? AND status <> 'deleted')
                    +
                    (SELECT COUNT(*)
                       FROM ${databaseTable("backup_artifact")}
                      WHERE storage_id = ? AND status <> 'deleted')
                  ) AS reference_count`,
                [storageId, storageId]
              )
            if (Number(references[0]?.reference_count ?? 0) > 0) {
              return yield* BackupStorageError.make({
                code: "storage_in_use",
                operation: "storage.delete",
                reason: "This destination still contains cataloged backups",
              })
            }
            yield* transaction.execute(
              `UPDATE ${databaseTable("backup_storage")}
                  SET deleting = TRUE, updated_at = ?
                WHERE id = ?`,
              [now, storageId]
            )
          }
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_policy")}
                SET storage_id = NULL, updated_at = ?
              WHERE storage_id = ?`,
            [now, storageId]
          )
          return {
            ...toRecord(existing),
            accessKeyId: accessKey.plaintext,
            secretAccessKey: secretKey.plaintext,
          } satisfies BackupStorageCredential
        })
      )
    )
    if (Result.isFailure(marked)) {
      const message =
        marked.failure instanceof Error
          ? marked.failure.message.slice(0, 512)
          : "The backup destination could not be deleted"
      yield* database.execute(
        "backup_storage_delete_mark_error",
        `UPDATE ${databaseTable("backup_storage")}
            SET last_error = ?, updated_at = ?
          WHERE id = ? AND deleting = TRUE`,
        [message, now, storageId]
      )
      return yield* marked.failure
    }
    const credential = marked.success
    const repositories = yield* database.queryRows<
      { id: string; object_prefix: string | null } & RowDataPacket
    >(
      "backup_storage_delete_repositories",
      `SELECT id, object_prefix
         FROM ${databaseTable("backup_repository")}
        WHERE storage_id = ?`,
      [storageId]
    )
    const purged = yield* Effect.result(
      Effect.forEach(repositories, (repository) =>
        repository.object_prefix
          ? deleteS3BackupPrefix(credential, repository.object_prefix)
          : Effect.void
      )
    )
    if (Result.isFailure(purged)) {
      const message =
        purged.failure instanceof Error
          ? purged.failure.message.slice(0, 512)
          : "The backup destination could not be purged"
      yield* database.execute(
        "backup_storage_delete_purge_error",
        `UPDATE ${databaseTable("backup_storage")}
            SET last_error = ?, updated_at = ?
          WHERE id = ?`,
        [message, now, storageId]
      )
      return yield* purged.failure
    }
    yield* database.transaction("backup_storage_delete_finish", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.queryRows<RowDataPacket>(
          `SELECT relay_id, target_kind, target_id
             FROM ${databaseTable("backup_policy")}
            WHERE storage_id = ?
            ORDER BY relay_id, target_kind, target_id
            FOR UPDATE`,
          [storageId]
        )
        yield* transaction.queryRows<RowDataPacket>(
          `SELECT id
             FROM ${databaseTable("backup_storage")}
            WHERE id = ?
            FOR UPDATE`,
          [storageId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")} backup
             JOIN ${databaseTable("backup_repository")} repository
               ON repository.id = backup.repository_id
              SET backup.repository_id = NULL, backup.updated_at = ?
            WHERE repository.storage_id = ? AND backup.status = 'deleted'`,
          [now, storageId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_artifact")}
              SET storage_id = NULL, updated_at = ?
            WHERE storage_id = ? AND status = 'deleted'`,
          [now, storageId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_repository")}
            WHERE storage_id = ?`,
          [storageId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_policy")}
              SET storage_id = NULL, updated_at = ?
            WHERE storage_id = ?`,
          [now, storageId]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup")}
              SET storage_id = NULL, updated_at = ?
            WHERE storage_id = ? AND status = 'deleted'`,
          [now, storageId]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("backup_storage")} WHERE id = ?`,
          [storageId]
        )
      })
    )
  }
)

const backupStoragePublicSelect = `SELECT id, owner_user_id, name, endpoint,
       region, bucket, object_prefix, force_path_style, allow_private_network,
       enabled, deleting,
       last_verified_at, last_error, created_at
  FROM ${databaseTable("backup_storage")}`

const backupStorageSelect = `SELECT id, owner_user_id, name, endpoint, region,
       bucket, object_prefix, force_path_style, allow_private_network,
       access_key_id_ciphertext, secret_access_key_ciphertext, enabled, deleting,
       last_verified_at, last_error, created_at
  FROM ${databaseTable("backup_storage")}`

function toRecord(row: BackupStoragePublicRow): BackupStorageRecord {
  return {
    allowPrivateNetwork: Boolean(row.allow_private_network),
    bucket: row.bucket,
    createdAt: timestampIso(row.created_at, "storage created at"),
    deleting: Boolean(row.deleting),
    enabled: Boolean(row.enabled),
    endpoint: row.endpoint,
    forcePathStyle: Boolean(row.force_path_style),
    id: row.id,
    lastError: row.last_error,
    lastVerifiedAt:
      row.last_verified_at === null
        ? null
        : timestampIso(row.last_verified_at, "storage verified at"),
    name: row.name,
    objectPrefix: row.object_prefix,
    ownerUserId: row.owner_user_id,
    region: row.region,
  }
}

function encryptCredential(
  plaintext: string,
  storageId: string,
  field: "access-key-id" | "secret-access-key"
) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        plaintext,
        betterAuthSecrets(),
        credentialPurpose(storageId, field)
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "encrypt_backup_storage_credential",
      }),
  })
}

function decryptCredential(
  ciphertext: string,
  storageId: string,
  field: "access-key-id" | "secret-access-key"
) {
  return Effect.try({
    try: () =>
      decryptWithKeyring(
        ciphertext,
        betterAuthSecrets(),
        credentialPurpose(storageId, field)
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "decrypt_backup_storage_credential",
      }),
  })
}

function credentialPurpose(
  storageId: string,
  field: "access-key-id" | "secret-access-key"
): string {
  return `kiln-backup-storage:${storageId}:${field}`
}

function timestampIso(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return new Date(value).toISOString()
}
