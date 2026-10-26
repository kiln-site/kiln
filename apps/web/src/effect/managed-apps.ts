import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { AppConfig } from "@workspace/contracts"
import { appConfigSchema, defaultAppConfig } from "@workspace/contracts"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
import { removeIconsEffect } from "@/effect/icons"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

const APP_CONFIG_PURPOSE = "kiln-app-config"

interface AppRow extends RowDataPacket {
  app_id: string
  created_at: number
  created_by: string
  name: string
  relay_id: string
}

interface AppConfigRow extends AppRow {
  config_ciphertext: string
}

export interface AppRecord {
  appId: string
  createdAt: string
  createdBy: string
  name: string
  relayId: string
}

export const listAppRecordsEffect = Effect.fn("apps.list")(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<AppRow>(
    "apps_list",
    `SELECT app_id, relay_id, name, created_by, created_at
       FROM ${databaseTable("app")}
      ORDER BY name ASC, created_at ASC`
  )
  return rows.map(toRecord)
})

export const appNameExistsEffect = Effect.fn("apps.nameExists")(function* (
  relayId: string,
  name: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<AppRow>(
    "app_name_exists",
    `SELECT app_id FROM ${databaseTable("app")}
      WHERE relay_id = ? AND name = ?
      LIMIT 1`,
    [relayId, name]
  )
  return rows.length > 0
})

export const createAppRecordEffect = Effect.fn("apps.create")(
  function* (input: {
    appId: string
    createdBy: string
    name: string
    relayId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const ciphertext = yield* encryptConfig(defaultAppConfig)
    yield* database.execute(
      "app_create",
      `INSERT INTO ${databaseTable("app")}
      (app_id, relay_id, name, config_ciphertext, created_by, owner_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.appId,
        input.relayId,
        input.name,
        ciphertext,
        input.createdBy,
        input.createdBy,
        now,
        now,
      ]
    )
  }
)

export const loadAppConfigEffect = Effect.fn("apps.config")(function* (
  relayId: string,
  appId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<AppConfigRow>(
    "app_config",
    `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
       FROM ${databaseTable("app")}
      WHERE relay_id = ? AND app_id = ?
      LIMIT 1`,
    [relayId, appId]
  )
  const row = rows.at(0)
  if (!row) return null
  return { ...toRecord(row), config: yield* decryptConfig(row) }
})

/**
 * Every app on a Relay with its config. One that can't be read, as when
 * the secret it was saved with is gone, is left out.
 */
export const listRelayAppConfigsEffect = Effect.fn("apps.configs")(function* (
  relayId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<AppConfigRow>(
    "app_configs",
    `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
       FROM ${databaseTable("app")}
      WHERE relay_id = ?`,
    [relayId]
  )
  return yield* Effect.forEach(rows, (row) =>
    decryptConfig(row).pipe(
      Effect.map((config) => [{ ...toRecord(row), config }]),
      Effect.catchCause(() => Effect.succeed([]))
    )
  ).pipe(Effect.map((apps) => apps.flat()))
})

/**
 * Changes part of an app's config against the one saved now, holding its
 * row while it does, so an edit saved meanwhile isn't overwritten.
 */
export const updateAppConfigEffect = Effect.fn("apps.updateConfig")(function* (
  relayId: string,
  appId: string,
  update: (config: AppConfig) => AppConfig
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction("app_config_update", (transaction) =>
    Effect.gen(function* () {
      const rows = yield* transaction.queryRows<AppConfigRow>(
        `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
           FROM ${databaseTable("app")}
          WHERE relay_id = ? AND app_id = ?
          LIMIT 1
            FOR UPDATE`,
        [relayId, appId]
      )
      const row = rows.at(0)
      if (!row) return yield* Effect.fail(new Error("App not found"))
      const config = update(yield* decryptConfig(row))
      yield* transaction.execute(
        `UPDATE ${databaseTable("app")}
            SET config_ciphertext = ?, updated_at = ?
          WHERE relay_id = ? AND app_id = ?`,
        [yield* encryptConfig(config), now, relayId, appId]
      )
      return config
    })
  )
})

function decryptConfig(row: AppConfigRow) {
  return Effect.try({
    try: () =>
      decryptWithKeyring(
        row.config_ciphertext,
        betterAuthSecrets(),
        APP_CONFIG_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({ operation: "decrypt_app_config", cause }),
  }).pipe(
    // Fields apps no longer have, like the data mount and disk limit, are
    // dropped from configs saved before.
    Effect.map((decrypted) =>
      appConfigSchema.strip().parse({
        ...defaultAppConfig,
        ...(JSON.parse(decrypted.plaintext) as object),
      })
    )
  )
}

// Hearth keeps the name; the Relay uses it only to label deployment logs.
export const renameAppRecordEffect = Effect.fn("apps.rename")(function* (
  relayId: string,
  appId: string,
  name: string
) {
  const database = yield* Database
  const taken = yield* database.queryRows<AppRow>(
    "app_rename_conflict",
    `SELECT app_id FROM ${databaseTable("app")}
      WHERE relay_id = ? AND name = ? AND app_id <> ?
      LIMIT 1`,
    [relayId, name, appId]
  )
  if (taken.length > 0) {
    return yield* Effect.fail(
      new Error(`An app named "${name}" already exists on this Relay`)
    )
  }
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "app_rename",
    `UPDATE ${databaseTable("app")}
        SET name = ?, updated_at = ?
      WHERE relay_id = ? AND app_id = ?`,
    [name, now, relayId, appId]
  )
  if (result.affectedRows !== 1) {
    return yield* Effect.fail(new Error("App not found"))
  }
})

export const deleteAppRecordEffect = Effect.fn("apps.delete")(function* (
  relayId: string,
  appId: string
) {
  const database = yield* Database
  yield* database.execute(
    "app_delete",
    `DELETE FROM ${databaseTable("app")} WHERE relay_id = ? AND app_id = ?`,
    [relayId, appId]
  )
  yield* removeIconsEffect({ kind: "app", relayId, id: appId })
})

function toRecord(row: AppRow): AppRecord {
  return {
    appId: row.app_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    createdBy: row.created_by,
    name: row.name,
    relayId: row.relay_id,
  }
}

function encryptConfig(config: AppConfig) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        JSON.stringify(config),
        betterAuthSecrets(),
        APP_CONFIG_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({ operation: "encrypt_app_config", cause }),
  })
}
