import type { RowDataPacket } from "mysql2/promise"
import { Cause, Clock, Effect, Predicate } from "effect"

import type { AppConfig } from "@workspace/contracts"
import {
  appConfigSchema,
  databaseIdSchema,
  defaultAppConfig,
} from "@workspace/contracts"
import { z } from "zod"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CredentialError } from "@/effect/errors"
import { removeIconsEffect } from "@/effect/icons"
import {
  configuredVolumeIds,
  importAppVolumeReferencesEffect,
  sendAppVolumeReferencesEffect,
} from "@/lib/app-volume-references.server"
import { databaseTable } from "@/lib/database-config"
import { volumeReferencesHeld } from "@/lib/volume-reference-gate"
import { betterAuthSecrets } from "@/lib/environment"

const APP_CONFIG_PURPOSE = "kiln-app-config"

// Configs saved before Relays kept Apps' database connections name them in
// `databaseIds`. Edits keep the field until Hearth hands it to the App's
// Relay and then drops it (lib/app-database-connections.server.ts); nothing
// else reads it.
const storedAppConfigSchema = appConfigSchema
  .extend({ databaseIds: z.array(databaseIdSchema).max(32).optional() })
  .strip()

type StoredAppConfig = z.infer<typeof storedAppConfigSchema>

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
 *
 * The Relay keeps which Kiln volumes the config mounts, so it can refuse to
 * delete them, and each message replaces the whole set. Before saving a
 * config that takes up a volume, the Relay gets the old and new configs'
 * volumes together, and a Relay that can't take them keeps the config from
 * saving; after every save it gets the saved config's. So the Relay never
 * knows of fewer than the saved config names, and a message lost after a
 * save is made good by the next save, or by the import when Hearth next
 * connects to the Relay.
 */
export const updateAppConfigEffect = Effect.fn("apps.updateConfig")(function* (
  relayId: string,
  appId: string,
  update: (config: AppConfig) => AppConfig
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const config = yield* database.transaction(
    "app_config_update",
    (transaction) =>
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
        const { databaseIds, ...previous } = yield* decryptStoredConfig(row)
        const config = update(previous)
        const before = configuredVolumeIds(previous)
        const after = configuredVolumeIds(config)
        if (after.some((id) => !before.includes(id))) {
          yield* sendAppVolumeReferencesEffect(relayId, appId, [
            ...new Set([...before, ...after]),
          ])
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("app")}
              SET config_ciphertext = ?, updated_at = ?
            WHERE relay_id = ? AND app_id = ?`,
          [
            yield* encryptConfig(
              databaseIds === undefined ? config : { ...config, databaseIds }
            ),
            now,
            relayId,
            appId,
          ]
        )
        return config
      })
  )
  // Saved either way: until the Relay hears, it only keeps a volume too
  // many, as when it's offline, and the next save or import tells it.
  yield* sendSavedAppVolumeReferencesEffect(relayId, appId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "The Relay didn't take the volumes an App's saved configuration mounts",
        Cause.squash(cause)
      )
    )
  )
  return config
})

// Tells the Relay the volumes the saved config names, holding its row so a
// save meanwhile can't reach the Relay out of order.
const sendSavedAppVolumeReferencesEffect = Effect.fn(
  "apps.volumeReferences.sendSaved"
)(function* (relayId: string, appId: string) {
  const database = yield* Database
  yield* database.transaction("app_volume_references", (transaction) =>
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
      if (!row) return
      yield* sendAppVolumeReferencesEffect(
        relayId,
        appId,
        configuredVolumeIds(yield* decryptConfig(row))
      )
    })
  )
})

/**
 * Sends a Relay the volumes every App's config on it names, holding their
 * rows so no save reaches the Relay in between. A config that can't be read
 * is sent as unresolved, so the Relay keeps refusing deletions until it
 * can be; answers how many there were.
 */
export const importRelayAppVolumeReferencesEffect = Effect.fn(
  "apps.volumeReferences.importRelay"
)(function* (relayId: string) {
  // Not while the database is replaced: what it reads may be gone after.
  for (let held = volumeReferencesHeld(); held; held = volumeReferencesHeld()) {
    yield* Effect.promise(() => held!)
  }
  const database = yield* Database
  return yield* database.transaction(
    "app_volume_references_import",
    (transaction) =>
      Effect.gen(function* () {
        const rows = yield* transaction.queryRows<AppConfigRow>(
          `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
           FROM ${databaseTable("app")}
          WHERE relay_id = ?
            FOR UPDATE`,
          [relayId]
        )
        const read = yield* Effect.forEach(rows, (row) =>
          decryptConfig(row).pipe(
            Effect.map((config) => ({
              appId: row.app_id,
              volumeIds: configuredVolumeIds(config),
            })),
            Effect.catchCause(() => Effect.succeed(row.app_id))
          )
        )
        const unresolved = read.filter(Predicate.isString)
        yield* importAppVolumeReferencesEffect(
          relayId,
          read.flatMap((entry) => (Predicate.isString(entry) ? [] : [entry])),
          unresolved
        )
        return { unresolved: unresolved.length }
      })
  )
})

/**
 * The Apps on a Relay whose configs still keep database connections, with
 * them, and those whose configs can't be read now, as when the secret they
 * were saved with is gone, so whether they keep any is unknown.
 */
export const listLegacyAppDatabaseIdsEffect = Effect.fn(
  "apps.legacyDatabaseIds"
)(function* (relayId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<AppConfigRow>(
    "app_configs_legacy_database_ids",
    `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
       FROM ${databaseTable("app")}
      WHERE relay_id = ?
      ORDER BY app_id`,
    [relayId]
  )
  const read = yield* Effect.forEach(rows, (row) =>
    decryptStoredConfig(row).pipe(
      Effect.map(({ databaseIds }) => ({
        appId: row.app_id,
        databaseIds: databaseIds ?? null,
      })),
      Effect.orElseSucceed(() => ({ appId: row.app_id, unreadable: true }))
    )
  )
  return {
    apps: read.flatMap((app) =>
      "databaseIds" in app && app.databaseIds !== null
        ? [{ appId: app.appId, databaseIds: app.databaseIds }]
        : []
    ),
    unreadable: read.flatMap((app) => ("unreadable" in app ? [app.appId] : [])),
  }
})

/**
 * Removes `databaseIds` from these Apps' configs, one App at a time, each
 * holding its row as an edit does. Safe to repeat: a config without it, or
 * one that can't be read, is left as it is.
 */
export const clearLegacyAppDatabaseIdsEffect = Effect.fn(
  "apps.clearLegacyDatabaseIds"
)(function* (relayId: string, appIds: ReadonlyArray<string>) {
  const database = yield* Database
  for (const appId of appIds) {
    yield* database.transaction(
      "app_config_clear_database_ids",
      (transaction) =>
        Effect.gen(function* () {
          const [row] = yield* transaction.queryRows<AppConfigRow>(
            `SELECT app_id, relay_id, name, config_ciphertext, created_by, created_at
               FROM ${databaseTable("app")}
              WHERE relay_id = ? AND app_id = ?
              LIMIT 1
                FOR UPDATE`,
            [relayId, appId]
          )
          if (!row) return
          const stored = yield* decryptStoredConfig(row).pipe(
            Effect.orElseSucceed(() => null)
          )
          if (!stored || stored.databaseIds === undefined) return
          const { databaseIds: _cleared, ...config } = stored
          yield* transaction.execute(
            `UPDATE ${databaseTable("app")}
                SET config_ciphertext = ?
              WHERE relay_id = ? AND app_id = ?`,
            [yield* encryptConfig(config), relayId, appId]
          )
        })
    )
  }
})

function decryptConfig(row: AppConfigRow) {
  return decryptStoredConfig(row).pipe(
    Effect.map(({ databaseIds: _legacy, ...config }): AppConfig => config)
  )
}

function decryptStoredConfig(row: AppConfigRow) {
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
      storedAppConfigSchema.parse({
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

function encryptConfig(config: StoredAppConfig) {
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
