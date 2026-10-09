import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { AppConfig } from "@workspace/contracts"
import { appConfigSchema, defaultAppConfig } from "@workspace/contracts"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
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
      (app_id, relay_id, name, config_ciphertext, created_by, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.appId,
        input.relayId,
        input.name,
        ciphertext,
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
  const decrypted = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        row.config_ciphertext,
        betterAuthSecrets(),
        APP_CONFIG_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({ operation: "decrypt_app_config", cause }),
  })
  const config = appConfigSchema.parse({
    ...defaultAppConfig,
    ...(JSON.parse(decrypted.plaintext) as object),
  })
  return { ...toRecord(row), config }
})

export const saveAppConfigEffect = Effect.fn("apps.saveConfig")(function* (
  relayId: string,
  appId: string,
  config: AppConfig
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const ciphertext = yield* encryptConfig(config)
  const result = yield* database.execute(
    "app_config_save",
    `UPDATE ${databaseTable("app")}
        SET config_ciphertext = ?, updated_at = ?
      WHERE relay_id = ? AND app_id = ?`,
    [ciphertext, now, relayId, appId]
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
