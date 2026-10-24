import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A fresh installation backs Kiln up once a day. Hearth can't create that
// schedule until an administrator and the Relay on Kiln's host exist, so a
// database migrated before anyone signed up is marked here, and Hearth
// creates the schedule once it can (see `seedDefaultKilnBackupSchedule`).
// Existing installations keep the schedules they chose.
export const defaultKilnBackupsSettingId =
  "d731afe6-a70c-4cf8-8fd3-bb9d70ba4b27"
export const defaultKilnBackupsSettingKey = "kiln.backups.default-schedule"

export const defaultKilnBackups: Migration = {
  id: 24,
  name: "default_kiln_backups",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM ${sql(databaseTableName("user"))}
    `
    if (Number(users[0]?.count ?? 0) > 0) return
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
