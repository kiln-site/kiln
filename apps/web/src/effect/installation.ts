import { randomUUID } from "node:crypto"

import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Clock, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { KilnInstallationIdSchema } from "@workspace/contracts"

import { databaseTableName } from "@/lib/database-config"
import { configuredKilnInstallationId } from "@/lib/environment"

import { databaseClientConfig } from "./database"

// One installation-wide row, so its fixed ID keeps it unique: MySQL's
// (user_id, setting_key) key allows any number of NULL user IDs.
const installationSettingId = "00000000-0000-4000-8000-000000000004"
const installationSettingKey = "kiln.installation"
// Hearth's platform backup target before it saved its own installation ID.
const legacyInstallationId = "kiln"

// mysql2 returns JSON columns parsed.
const decodeInstallationSetting = Schema.decodeUnknownOption(
  Schema.Struct({ id: KilnInstallationIdSchema })
)

// Kept on globalThis because Vite reloads this module in development
// without restarting Hearth.
const loaded = globalThis as typeof globalThis & {
  kilnInstallationId?: string
}

/**
 * The ID shared by this Hearth, its database, and its Relays. It names the
 * installation in Docker labels, backup object keys, and telemetry.
 */
export function kilnInstallationId(): string {
  const id = loadedKilnInstallationId()
  if (!id) throw new Error("Hearth has not loaded its installation ID")
  return id
}

/** The installation ID, or null before Hearth has loaded it at startup. */
export function loadedKilnInstallationId(): string | null {
  return configuredKilnInstallationId() ?? loaded.kilnInstallationId ?? null
}

/**
 * Loads the installation ID before Hearth serves requests or connects to
 * Relays. `KILN_INSTALLATION_ID` wins and is saved, so the installation
 * keeps it if the variable is later removed. Otherwise Hearth keeps the ID
 * it saved, or generates one on its first start.
 */
export function loadInstallationId(): Promise<string> {
  return Effect.runPromise(
    ensureInstallationId().pipe(
      Effect.provide(MysqlClient.layer(databaseClientConfig(1)))
    )
  )
}

export const ensureInstallationId = Effect.fn("Installation.ensure")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("setting")
    const configured = configuredKilnInstallationId()
    const now = yield* Clock.currentTimeMillis
    const id = yield* sql.withTransaction(
      Effect.gen(function* () {
        if (configured) {
          yield* sql`
            INSERT INTO ${sql(table)}
              (id, user_id, setting_key, setting_value, created_at, updated_at)
            VALUES (${installationSettingId}, NULL, ${installationSettingKey},
                    ${JSON.stringify({ id: configured })}, ${now}, ${now})
            ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                    updated_at = VALUES(updated_at)
          `
          return configured
        }
        const generated = randomUUID()
        // Concurrent first starts all insert; only one row survives, and
        // every start reads that one back.
        yield* sql`
          INSERT INTO ${sql(table)}
            (id, user_id, setting_key, setting_value, created_at, updated_at)
          VALUES (${installationSettingId}, NULL, ${installationSettingKey},
                  ${JSON.stringify({ id: generated })}, ${now}, ${now})
          ON DUPLICATE KEY UPDATE id = id
        `
        const rows = yield* sql<{ setting_value: unknown }>`
          SELECT setting_value FROM ${sql(table)}
          WHERE id = ${installationSettingId}
        `
        const saved = decodeInstallationSetting(rows[0]?.setting_value).pipe(
          Option.map(({ id }) => id),
          Option.getOrNull
        )
        if (!saved) {
          return yield* Effect.die(
            new Error("The saved installation ID is unreadable")
          )
        }
        if (saved === generated) {
          // An installation from before saved IDs used the fallback for its
          // platform backup settings; carry them over to the new ID.
          yield* sql`
            UPDATE IGNORE ${sql(databaseTableName("backup_policy"))}
            SET target_id = ${generated}, updated_at = ${now}
            WHERE target_kind = 'platform'
              AND target_id = ${legacyInstallationId}
          `
        }
        return saved
      })
    )
    loaded.kilnInstallationId = id
    return id
  }
)
