import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
} from "@/lib/notification-preferences"

const notificationsSettingKey = "notifications"

const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

function storedValue(value: unknown): unknown {
  return typeof value === "string"
    ? Option.getOrNull(decodeJsonString(value))
    : value
}

interface PreferenceRow extends RowDataPacket {
  setting_value: unknown
  user_id: string
}

/** Each user's choices; users who never chose get the defaults. */
export const loadNotificationPreferencesEffect = Effect.fnUntraced(function* (
  userIds: ReadonlyArray<string>
) {
  const preferences = new Map<string, NotificationPreferences>()
  if (!userIds.length) return preferences
  const database = yield* Database
  const rows = yield* database.queryRows<PreferenceRow>(
    "notificationPreferences.load",
    `SELECT user_id, setting_value FROM ${databaseTable("setting")}
      WHERE setting_key = ?
        AND user_id IN (${userIds.map(() => "?").join(", ")})`,
    [notificationsSettingKey, ...userIds]
  )
  for (const row of rows)
    preferences.set(
      row.user_id,
      normalizeNotificationPreferences(storedValue(row.setting_value))
    )
  for (const userId of userIds)
    if (!preferences.has(userId))
      preferences.set(userId, normalizeNotificationPreferences(null))
  return preferences
})

export const loadUserNotificationPreferencesEffect = Effect.fn(
  "notificationPreferences.loadUser"
)(function* (userId: string) {
  const preferences = yield* loadNotificationPreferencesEffect([userId])
  return preferences.get(userId) ?? normalizeNotificationPreferences(null)
})

/** Saves the given choices over the user's stored ones. */
export const saveNotificationPreferencesEffect = Effect.fn(
  "notificationPreferences.save"
)(function* (userId: string, update: NotificationPreferencesUpdate) {
  const database = yield* Database
  const table = databaseTable("setting")
  return yield* database.transaction("notificationPreferences.save", (tx) =>
    Effect.gen(function* () {
      const [row] = yield* tx.queryRows<
        RowDataPacket & { setting_value: unknown }
      >(
        `SELECT setting_value FROM ${table}
          WHERE user_id = ? AND setting_key = ?
          LIMIT 1
          FOR UPDATE`,
        [userId, notificationsSettingKey]
      )
      const merged = mergeNotificationPreferences(
        row ? storedValue(row.setting_value) : null,
        update
      )
      const now = yield* Clock.currentTimeMillis
      yield* tx.execute(
        `INSERT INTO ${table}
           (id, user_id, setting_key, setting_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                 updated_at = VALUES(updated_at)`,
        [
          randomUUID(),
          userId,
          notificationsSettingKey,
          JSON.stringify(merged),
          now,
          now,
        ]
      )
      return normalizeNotificationPreferences(merged)
    })
  )
})
