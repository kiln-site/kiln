import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// Devices that asked for push notifications, one row per user and browser
// push endpoint. Each row belongs to the sign-in that turned push on, so
// signing out or revoking that session stops pushes to the device.
// `push_pending` marks notifications waiting to be pushed. Only new ones set
// it, so existing rows need no backfill: adding the column is instant and the
// index builds online, and each step is skipped once done, so a migration
// that stopped partway finishes on the next start.
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
    if (!columns.some((column) => column.columnName === "push_pending")) {
      yield* sql.unsafe(`ALTER TABLE \`${notification}\`
  ADD COLUMN \`push_pending\` tinyint unsigned DEFAULT NULL`)
    }
    const indexes = yield* sql<{ indexName: string }>`
      SELECT index_name AS indexName
      FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ${notification}
    `
    if (
      !indexes.some((index) => index.indexName === `${notification}_push_idx`)
    ) {
      yield* sql.unsafe(`ALTER TABLE \`${notification}\`
  ADD KEY \`${notification}_push_idx\` (\`push_pending\`)`)
    }
  }),
}
