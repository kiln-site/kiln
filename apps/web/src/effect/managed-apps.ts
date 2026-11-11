import type { RowDataPacket } from "mysql2/promise"
import { Cause, Clock, Effect, Predicate } from "effect"

import type { AppConfig } from "@workspace/contracts"
import {
  APP_SERVICE,
  appConfigSchema,
  appEnvironmentVariables,
  brickInputValueSchema,
  brickSourceSchema,
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
  /** Only where it was asked for. */
  brick_ciphertext?: string | null
  config_ciphertext: string
}

const APP_BRICK_PURPOSE = "kiln-app-brick"

/**
 * What an App keeps of the Brick it follows, beside its configuration: the
 * Brick and the revision its configuration was last made from, the answers
 * that made it, and which of its variables are the Brick's. An App made
 * from one of Kiln's generic Bricks keeps none: everything about it is its
 * owner's.
 */
export const appBrickRecordSchema = z.strictObject({
  /** Its answers, a secret Kiln made among them. A group's are the group's. */
  answers: z.record(z.string(), brickInputValueSchema).default({}),
  /**
   * The databases of its group the Brick connected it to, by what the Brick
   * calls them. A revision writes it their addresses, and connects nothing.
   */
  connect: z.array(z.string()).optional(),
  /** The variables of its environment the Brick set. */
  environment: z.array(z.string()).default([]),
  /** Which App of a group Brick it is. */
  member: z.string().min(1).max(64).optional(),
  /** The Brick's name, as it was when installed. */
  name: z.string().min(1).max(80),
  revision: z.number().int().min(1),
  source: brickSourceSchema,
  /**
   * The folders the Brick keeps, each on a volume mounted there. Which
   * volume is its owner's to say.
   */
  volumes: z.array(z.string()).default([]),
})
export type AppBrickRecord = z.infer<typeof appBrickRecordSchema>

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
    /** The Brick it follows, when it follows one. */
    brick?: AppBrickRecord
    createdBy: string
    /** What its Brick deploys. Without one, nothing yet. */
    deploys?: Pick<AppConfig, "sourceType"> & { image?: string }
    environment?: string
    /** What it mounts from the start: the volumes its Brick keeps. */
    mounts?: AppConfig["mounts"]
    name: string
    relayId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const config = appConfigSchema.parse({
      ...defaultAppConfig,
      ...input.deploys,
      environment: input.environment ?? "",
      mounts: input.mounts ?? [],
    })
    // Its Relay hears of the volumes it mounts before it is kept, as before
    // any save that takes one up (`changeAppEffect`): a Relay that can't
    // take them keeps the App from being made.
    const mounted = configuredVolumeIds(config)
    if (mounted.length > 0) {
      yield* sendAppVolumeReferencesEffect(input.relayId, input.appId, mounted)
    }
    const ciphertext = yield* encryptConfig(config)
    // One that isn't kept after all names what is saved for it, if
    // anything is: nothing, unless this ID's App was already there.
    const unkept =
      mounted.length === 0
        ? Effect.void
        : sendSavedAppVolumeReferencesEffect(input.relayId, input.appId).pipe(
            Effect.catchCause(() => Effect.void)
          )
    yield* database
      .execute(
      "app_create",
      `INSERT INTO ${databaseTable("app")}
      (app_id, relay_id, name, config_ciphertext, brick_ciphertext,
       created_by, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.appId,
        input.relayId,
        input.name,
        ciphertext,
        input.brick ? yield* encryptBrick(input.brick) : null,
        input.createdBy,
        input.createdBy,
        now,
        now,
      ]
      )
      .pipe(Effect.tapError(() => unkept))
  }
)

export const loadAppConfigEffect = Effect.fn("apps.config")(function* (
  relayId: string,
  appId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<AppConfigRow>(
    "app_config",
    `SELECT app_id, relay_id, name, config_ciphertext, brick_ciphertext,
            created_by, created_at
       FROM ${databaseTable("app")}
      WHERE relay_id = ? AND app_id = ?
      LIMIT 1`,
    [relayId, appId]
  )
  const row = rows.at(0)
  if (!row) return null
  return {
    ...toRecord(row),
    brick: yield* decryptBrick(row),
    config: yield* decryptConfig(row),
  }
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
    `SELECT app_id, relay_id, name, config_ciphertext, brick_ciphertext,
            created_by, created_at
       FROM ${databaseTable("app")}
      WHERE relay_id = ?`,
    [relayId]
  )
  return yield* Effect.forEach(rows, (row) =>
    Effect.all({ brick: decryptBrick(row), config: decryptConfig(row) }).pipe(
      Effect.map((read) => [{ ...toRecord(row), ...read }]),
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
export const updateAppConfigEffect = (
  relayId: string,
  appId: string,
  update: (config: AppConfig) => AppConfig
) =>
  changeAppEffect(relayId, appId, ({ brick, config }) => {
    const next = update(config)
    // What its Brick set stays as the Brick set it, for as long as the App
    // follows the Brick: the next revision would put it back anyway.
    const held = brick ? heldByAppBrick(config, next, brick) : null
    return held === null
      ? Effect.succeed({ brick, config: next })
      : Effect.fail(
          new Error(
            `${held} is set by its Brick, ${brick?.name}. Detach it from the Brick to change it.`
          )
        )
  }).pipe(Effect.map(({ config }) => config))

/**
 * What a change would alter that an App's Brick set, or null: what it
 * deploys and how it starts, the variables the Brick wrote, and that each
 * folder the Brick keeps is on a volume. Which volume that is, and
 * everything else about an App, is its owner's, following a Brick or not.
 */
export function heldByAppBrick(
  saved: AppConfig,
  next: AppConfig,
  brick: Pick<AppBrickRecord, "environment" | "volumes">
): string | null {
  if (next.sourceType !== saved.sourceType) return "What it deploys"
  if (next.image !== saved.image) return "Its image"
  if (next.command !== saved.command) return "Its start command"
  if (next.mounts !== saved.mounts) {
    const unkept = brick.volumes.find(
      (folder) =>
        !next.mounts.some(
          (mount) =>
            mount.target === folder &&
            mount.source.type === "volume" &&
            !mount.readOnly &&
            // In the one container an image or a Dockerfile runs: a mount
            // for another service is mounted nowhere.
            (mount.service === null || mount.service === APP_SERVICE)
        )
    )
    if (unkept !== undefined) return `The volume at ${unkept}`
  }
  if (next.environment === saved.environment) return null
  const before = appEnvironmentVariables(saved.environment)
  const after = appEnvironmentVariables(next.environment)
  return brick.environment.find((name) => before[name] !== after[name]) ?? null
}

/** What an App is: its configuration, and the Brick it follows, if any. */
export interface AppFollowing {
  brick: AppBrickRecord | null
  config: AppConfig
}

/**
 * Stops an App following its Brick. It stays as it is, and every part of
 * it becomes its owner's to change.
 */
export const detachAppBrickEffect = (relayId: string, appId: string) =>
  changeAppEffect(relayId, appId, ({ config }) =>
    Effect.succeed({ brick: null, config })
  )

/**
 * Changes an App's configuration, and the Brick it follows, against what
 * is saved now. For the changes its Brick makes itself: what someone edits
 * goes through `updateAppConfigEffect`, which holds what the Brick set.
 */
export const changeAppEffect = Effect.fn("apps.change")(function* <E, R>(
  relayId: string,
  appId: string,
  change: (app: AppFollowing) => Effect.Effect<AppFollowing, E, R>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const changed = yield* database.transaction(
    "app_config_update",
    (transaction) =>
      Effect.gen(function* () {
        const rows = yield* transaction.queryRows<AppConfigRow>(
          `SELECT app_id, relay_id, name, config_ciphertext, brick_ciphertext,
                  created_by, created_at
             FROM ${databaseTable("app")}
            WHERE relay_id = ? AND app_id = ?
            LIMIT 1
              FOR UPDATE`,
          [relayId, appId]
        )
        const row = rows.at(0)
        if (!row) return yield* Effect.fail(new Error("App not found"))
        const { databaseIds, ...previous } = yield* decryptStoredConfig(row)
        const { brick, config } = yield* change({
          brick: yield* decryptBrick(row),
          config: previous,
        })
        const before = configuredVolumeIds(previous)
        const after = configuredVolumeIds(config)
        if (after.some((id) => !before.includes(id))) {
          yield* sendAppVolumeReferencesEffect(relayId, appId, [
            ...new Set([...before, ...after]),
          ])
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("app")}
              SET config_ciphertext = ?, brick_ciphertext = ?, updated_at = ?
            WHERE relay_id = ? AND app_id = ?`,
          [
            yield* encryptConfig(
              databaseIds === undefined ? config : { ...config, databaseIds }
            ),
            brick ? yield* encryptBrick(brick) : null,
            now,
            relayId,
            appId,
          ]
        )
        return { brick, config }
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
  return changed
})

/**
 * Tells the Relay the volumes the saved config names, holding its row so a
 * save meanwhile can't reach the Relay out of order. An App Hearth keeps no
 * record of names none.
 */
export const sendSavedAppVolumeReferencesEffect = Effect.fn(
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
      yield* sendAppVolumeReferencesEffect(
        relayId,
        appId,
        row ? configuredVolumeIds(yield* decryptConfig(row)) : []
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

function encryptBrick(brick: AppBrickRecord) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        JSON.stringify(brick),
        betterAuthSecrets(),
        APP_BRICK_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({ operation: "encrypt_app_brick", cause }),
  })
}

// The Brick an App follows, or null for one that follows none.
function decryptBrick(row: AppConfigRow) {
  const ciphertext = row.brick_ciphertext
  if (ciphertext === null || ciphertext === undefined) {
    return Effect.succeed(null)
  }
  return Effect.try({
    try: () =>
      appBrickRecordSchema.parse(
        JSON.parse(
          decryptWithKeyring(ciphertext, betterAuthSecrets(), APP_BRICK_PURPOSE)
            .plaintext
        )
      ),
    catch: (cause) =>
      CredentialError.make({ operation: "decrypt_app_brick", cause }),
  })
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
