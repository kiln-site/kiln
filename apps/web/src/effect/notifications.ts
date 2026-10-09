import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Predicate, Schema } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { developmentBypassUserId } from "@/lib/development-bypass"
import { developmentBypassEnabled } from "@/lib/environment"
import {
  notificationContentSchema,
  type KilnNotification,
  type NotificationContent,
  type NotificationCursor,
  type NotificationPage,
} from "@/lib/notifications"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

interface NotificationRow extends RowDataPacket {
  created_at: number | string
  data: unknown
  id: string
  kind: string
  read_at: number | string | null
}

/**
 * Delivers one notification to each user. A user who already has a
 * notification for `sourceKey` keeps it unchanged, so callers can retry or
 * re-announce without duplicates. Inside a transaction the rows commit with it.
 */
export const notifyUsersEffect = Effect.fn("notifications.notify")(function* (
  userIds: ReadonlyArray<string>,
  sourceKey: string,
  content: NotificationContent
) {
  const recipients = [...new Set(userIds)]
  if (!recipients.length) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const { kind, ...data } = content
  const json = JSON.stringify(data)
  yield* database.execute(
    "notifications.notify",
    `INSERT INTO ${databaseTable("notification")}
       (id, user_id, kind, source_key, data, created_at)
     VALUES ${recipients.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
     ON DUPLICATE KEY UPDATE id = id`,
    recipients.flatMap((userId) => [
      randomUUID(),
      userId,
      kind,
      sourceKey,
      json,
      now,
    ])
  )
})

/** Tells the users' open tabs to reload their notifications. */
export function publishNotificationChange(userIds: ReadonlyArray<string>) {
  if (!userIds.length) return
  publishRealtimeChange({
    audience: { kind: "users", userIds: [...new Set(userIds)] },
    topics: ["notifications"],
    type: "hearth.invalidate",
  })
}

/**
 * The user's notifications, newest first, `limit` at a time. Pass the last
 * row of a page as `before` to continue after it.
 */
export const listNotificationsEffect = Effect.fn("notifications.list")(
  function* (userId: string, limit: number, before?: NotificationCursor) {
    const database = yield* Database
    const rows = yield* database.queryRows<NotificationRow>(
      "notifications.list",
      `SELECT id, kind, data, created_at, read_at
         FROM ${databaseTable("notification")}
        WHERE user_id = ? AND dismissed_at IS NULL${
          before ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : ""
        }
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      before
        ? [userId, before.createdAt, before.createdAt, before.id, limit]
        : [userId, limit]
    )
    const notifications = rows.flatMap((row): Array<KilnNotification> => {
      // Rows outlive Kiln versions; skip kinds this version can't show.
      const content = decodeContent(row)
      return Option.isSome(content)
        ? [
            {
              content: content.value,
              createdAt: Number(row.created_at),
              id: row.id,
              readAt: row.read_at === null ? null : Number(row.read_at),
            },
          ]
        : []
    })
    // Continue after the last row read, even one this version skipped.
    const last = rows.length === limit ? rows.at(-1) : undefined
    const nextCursor: NotificationCursor | null = last
      ? { createdAt: Number(last.created_at), id: last.id }
      : null
    return { nextCursor, notifications } satisfies NotificationPage
  }
)

export const countUnreadNotificationsEffect = Effect.fn(
  "notifications.countUnread"
)(function* (userId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { count: number }>(
    "notifications.countUnread",
    `SELECT COUNT(*) AS count
       FROM ${databaseTable("notification")}
      WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL`,
    [userId]
  )
  return Number(rows[0]?.count ?? 0)
})

/**
 * Marks the user's notifications created at or before `through` as read.
 * Anything delivered after the user looked stays unread.
 */
export const markNotificationsReadEffect = Effect.fn("notifications.markRead")(
  function* (userId: string, through: number) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "notifications.markRead",
      `UPDATE ${databaseTable("notification")}
          SET read_at = ?
        WHERE user_id = ? AND read_at IS NULL AND created_at <= ?`,
      [now, userId, through]
    )
    return result.affectedRows
  }
)

/**
 * Clears one of the user's notifications. The row stays dismissed so the event
 * that sent it is never delivered to this user again.
 */
export const dismissNotificationEffect = Effect.fn("notifications.dismiss")(
  function* (userId: string, id: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "notifications.dismiss",
      `UPDATE ${databaseTable("notification")}
          SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
        WHERE id = ? AND user_id = ? AND dismissed_at IS NULL`,
      [now, now, id, userId]
    )
    return result.affectedRows
  }
)

/**
 * Clears the user's notifications created at or before `through`, so anything
 * delivered after the user looked stays in the inbox.
 */
export const clearNotificationsEffect = Effect.fn("notifications.clear")(
  function* (userId: string, through: number) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "notifications.clear",
      `UPDATE ${databaseTable("notification")}
          SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
        WHERE user_id = ? AND dismissed_at IS NULL AND created_at <= ?`,
      [now, now, userId, through]
    )
    return result.affectedRows
  }
)

/** Enabled platform administrators, who hear about Kiln releases. */
export const platformAdminIdsEffect = Effect.fn("notifications.platformAdmins")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
      "notifications.platformAdmins",
      `SELECT id FROM ${databaseTable("user")}
        WHERE role = 'admin' AND status = 'enabled'`
    )
    const ids = rows.map((row) => row.id)
    return developmentBypassEnabled() ? [...ids, developmentBypassUserId] : ids
  }
)

const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

function decodeContent(
  row: NotificationRow
): Option.Option<NotificationContent> {
  const data =
    typeof row.data === "string"
      ? decodeJsonString(row.data)
      : Option.some(row.data)
  return data.pipe(
    Option.filter(Predicate.isObject),
    Option.flatMap((value) => {
      const parsed = notificationContentSchema.safeParse({
        ...value,
        kind: row.kind,
      })
      return parsed.success ? Option.some(parsed.data) : Option.none()
    })
  )
}
