import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Devices that asked for push notifications, one row per user and browser
// push endpoint. Each row belongs to the sign-in that turned push on, so
// signing out or revoking that session stops pushes to the device.
// `pushed_at` marks notifications Hearth has already pushed, or decided not
// to; ones delivered before push existed count as done.
export const pushSubscriptions: Migration = {
  id: 21,
  name: "push_subscriptions",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const subscription = databaseTableName("push_subscription")
    const notification = databaseTableName("notification")

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS \`${subscription}\` (
  \`id\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`user_id\` varchar(36) NOT NULL,
  \`session_id\` varchar(255) NOT NULL,
  \`endpoint\` varchar(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`p256dh\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`auth\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  \`created_at\` bigint unsigned NOT NULL,
  \`updated_at\` bigint unsigned NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`${subscription}_user_idx\` (\`user_id\`)
)`)

    const columns = yield* sql<{ columnName: string }>`
      SELECT column_name AS columnName
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ${notification}
    `
    if (!columns.some((column) => column.columnName === "pushed_at")) {
      yield* sql.unsafe(`ALTER TABLE \`${notification}\`
  ADD COLUMN \`pushed_at\` bigint unsigned DEFAULT NULL AFTER \`dismissed_at\`,
  ADD KEY \`${notification}_push_idx\` (\`pushed_at\`)`)
      yield* sql.unsafe(`UPDATE \`${notification}\`
  SET \`pushed_at\` = \`created_at\` WHERE \`pushed_at\` IS NULL`)
    }
  }),
}
