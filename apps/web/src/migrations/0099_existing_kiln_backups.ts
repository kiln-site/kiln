import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

import {
  defaultKilnBackupsSettingId,
  defaultKilnBackupsSettingKey,
} from "./0024_default_kiln_backups"

// An installation from before Kiln backed itself up by default gets the daily
// schedule a fresh one does, unless something already backs Kiln up, or the
// default was made and deleted.
export const existingKilnBackups: Migration = {
  id: 99,
  name: "existing_kiln_backups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [scheduled] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count
        FROM ${sql(databaseTableName("schedule_target"))}
       WHERE target_kind = 'relay'
    `
    if (Number(scheduled?.count ?? 0) > 0) return
    const now = yield* Clock.currentTimeMillis
    yield* sql`
      INSERT INTO ${sql(databaseTableName("setting"))}
        (id, user_id, setting_key, setting_value, created_at, updated_at)
      VALUES (${defaultKilnBackupsSettingId}, NULL,
              ${defaultKilnBackupsSettingKey},
              ${JSON.stringify({ state: "pending" })}, ${now}, ${now})
      ON DUPLICATE KEY UPDATE id = id
    `
  }),
}
