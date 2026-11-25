import {
  backupRepositoryPassword,
  createBackupPassword,
  type BackupRecoveryPasswords,
} from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

// What opens a repository of incremental backups without Kiln: one password
// made from Kiln's recovery code, its administrators', and its destination's
// own, its owner's. A Relay adds them to each repository as it backs up.

const rootSettingId = "00000000-0000-4000-8000-000000000007"
const rootSettingKey = "backup-repository-root"
const rootPurpose = "kiln-backup-repository-root"
const destinationPurpose = (storageId: string) =>
  `kiln-backup-storage:${storageId}:backup-password`

const encrypt = (plaintext: string, purpose: string) =>
  Effect.try({
    try: () => encryptWithKeyring(plaintext, betterAuthSecrets(), purpose),
    catch: (cause) =>
      CredentialError.make({ cause, operation: "encrypt_backup_password" }),
  })

const decrypt = (ciphertext: string, purpose: string) =>
  Effect.try({
    try: () =>
      decryptWithKeyring(ciphertext, betterAuthSecrets(), purpose).plaintext,
    catch: (cause) =>
      CredentialError.make({ cause, operation: "decrypt_backup_password" }),
  })

const RootSetting = Schema.Struct({ ciphertext: Schema.String })
// mysql2 returns JSON columns parsed, and MariaDB's as text.
const decodeRoot = Schema.decodeUnknownOption(RootSetting)
const decodeRootJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RootSetting)
)

const loadRoot = Effect.fnUntraced(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "backupPasswords.loadRoot",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1`,
    [rootSettingId, rootSettingKey]
  )
  const value = row?.setting_value
  const setting =
    typeof value === "string" ? decodeRootJson(value) : decodeRoot(value)
  return Option.isSome(setting)
    ? yield* decrypt(setting.value.ciphertext, rootPurpose)
    : null
})

/**
 * Keeps what Kiln's passwords are made from, as its recovery code gives it.
 * Schedules carry those passwords, so a new one is owed to their Relays.
 */
export const saveBackupRepositoryRoot = Effect.fn("backupPasswords.saveRoot")(
  function* (root: string) {
    const saved = yield* loadRoot().pipe(Effect.orElseSucceed(() => null))
    if (saved === root) return
    const database = yield* Database
    const ciphertext = yield* encrypt(root, rootPurpose)
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("backup_passwords_root", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("setting")}
             (id, user_id, setting_key, setting_value, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                   updated_at = VALUES(updated_at)`,
          [
            rootSettingId,
            rootSettingKey,
            JSON.stringify({ ciphertext }),
            now,
            now,
          ]
        )
        yield* invalidateScheduleDeploymentsEffect(transaction, {
          everyBackup: true,
        })
      })
    )
  }
)

/** A destination's password, made when it's first asked for. */
export const backupStoragePassword = Effect.fn("backupPasswords.destination")(
  function* (storageId: string) {
    const database = yield* Database
    const ciphertext = yield* database.transaction(
      "backup_passwords_destination",
      (transaction) =>
        Effect.gen(function* () {
          const [row] = yield* transaction.queryRows<
            RowDataPacket & { password_ciphertext: string | null }
          >(
            `SELECT password_ciphertext
               FROM ${databaseTable("backup_storage")}
              WHERE id = ?
              FOR UPDATE`,
            [storageId]
          )
          if (!row) return null
          if (row.password_ciphertext) return row.password_ciphertext
          const made = yield* encrypt(
            createBackupPassword(),
            destinationPurpose(storageId)
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("backup_storage")}
                SET password_ciphertext = ?
              WHERE id = ?`,
            [made, storageId]
          )
          return made
        })
    )
    return ciphertext === null
      ? null
      : yield* decrypt(ciphertext, destinationPurpose(storageId))
  }
)

/**
 * What a Relay adds to a repository as it backs up into it. A backup is worth
 * more than what opens it later, so one that can't be read is left out.
 */
export const repositoryRecoveryPasswords = Effect.fn(
  "backupPasswords.repository"
)(
  function* (repository: { id: string; storageId: string | null }) {
    const root = yield* loadRoot()
    const destination = repository.storageId
      ? yield* backupStoragePassword(repository.storageId)
      : null
    const passwords: BackupRecoveryPasswords = [
      ...(root
        ? [
            {
              holder: "kiln" as const,
              password: yield* promiseEffect(() =>
                backupRepositoryPassword(root, repository.id)
              ),
            },
          ]
        : []),
      ...(destination
        ? [{ holder: "destination" as const, password: destination }]
        : []),
    ]
    return passwords
  },
  Effect.catch((cause) =>
    Effect.logWarning(
      "A backup repository's recovery passwords are unreadable",
      cause
    ).pipe(Effect.as<BackupRecoveryPasswords>([]))
  )
)
