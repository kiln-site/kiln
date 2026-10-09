import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Predicate, Schema } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { developmentBypassUserId } from "@/lib/development-bypass"
import { developmentBypassEnabled } from "@/lib/environment"
import {
  notificationContentSchema,
  notificationHistoryLimit,
  type InvitationOutcome,
  type KilnNotification,
  type NotificationContent,
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

/**
 * Records how a user's invitations ended on their notifications, so the inbox
 * shows the answer in place of Accept and Decline. An answer marks them read;
 * a cancellation leaves them for the user to notice. Inside a transaction the
 * change commits with the decision.
 */
export const resolveInvitationNotificationsEffect = Effect.fn(
  "notifications.resolveInvitations"
)(function* (
  userId: string,
  invitationIds: ReadonlyArray<string>,
  outcome: InvitationOutcome
) {
  if (!invitationIds.length) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "notifications.resolveInvitations",
    `UPDATE ${databaseTable("notification")}
        SET data = JSON_SET(data, '$.outcome', ?),
            read_at = COALESCE(read_at, ?)
      WHERE user_id = ? AND kind = 'access.invited'
        AND source_key IN (${invitationIds.map(() => "?").join(", ")})`,
    [
      outcome,
      outcome === "cancelled" ? null : now,
      userId,
      ...invitationIds.map((id) => `access.invited:${id}`),
    ]
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
 * The user's newest notifications, newest first. History is capped so the
 * whole inbox stays one small sync. Unanswered invitations carry their
 * invitation's current state, so one answered elsewhere, cancelled, or
 * expired never offers Accept and Decline.
 */
export const listNotificationsEffect = Effect.fn("notifications.list")(
  function* (userId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<NotificationRow>(
      "notifications.list",
      `SELECT id, kind, data, created_at, read_at
         FROM ${databaseTable("notification")}
        WHERE user_id = ? AND dismissed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${notificationHistoryLimit}`,
      [userId]
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
    const outcomes = yield* invitationOutcomesEffect(
      userId,
      notifications.flatMap(({ content }) =>
        content.kind === "access.invited" && content.outcome === undefined
          ? [content.invitationId]
          : []
      )
    )
    return notifications.map((notification) => {
      const { content } = notification
      if (content.kind !== "access.invited" || content.outcome !== undefined)
        return notification
      const outcome = outcomes.get(content.invitationId)
      return outcome
        ? { ...notification, content: { ...content, outcome } }
        : notification
    })
  }
)

// The state of the user's invitations that are no longer pending. One that
// no longer exists counts as cancelled.
const invitationOutcomesEffect = Effect.fnUntraced(function* (
  userId: string,
  invitationIds: ReadonlyArray<string>
) {
  const outcomes = new Map<string, InvitationOutcome>()
  if (!invitationIds.length) return outcomes
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<
    RowDataPacket & { id: string; outcome: InvitationOutcome | null }
  >(
    "notifications.invitationOutcomes",
    `SELECT id,
            CASE
              WHEN accepted_at IS NOT NULL THEN 'accepted'
              WHEN declined_at IS NOT NULL THEN 'declined'
              WHEN revoked_at IS NOT NULL OR cancelled_at IS NOT NULL
                THEN 'cancelled'
              WHEN expires_at <= ? THEN 'expired'
            END AS outcome
       FROM ${databaseTable("invitation")}
      WHERE user_id = ? AND id IN (${invitationIds.map(() => "?").join(", ")})`,
    [now, userId, ...invitationIds]
  )
  for (const id of invitationIds) outcomes.set(id, "cancelled")
  for (const row of rows) {
    if (row.outcome) outcomes.set(row.id, row.outcome)
    else outcomes.delete(row.id)
  }
  return outcomes
})

/**
 * Marks the user's unread notifications as read: the given IDs, or all of
 * them. Returns the IDs this call marked.
 */
export const markNotificationsReadEffect = Effect.fn("notifications.markRead")(
  function* (userId: string, ids: ReadonlyArray<string> | "all") {
    if (ids !== "all" && !ids.length) return []
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("notifications.markRead", (tx) =>
      Effect.gen(function* () {
        const unread = yield* tx.queryRows<RowDataPacket & { id: string }>(
          `SELECT id FROM ${databaseTable("notification")}
            WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL${
              ids === "all"
                ? ""
                : ` AND id IN (${ids.map(() => "?").join(", ")})`
            }
            FOR UPDATE`,
          ids === "all" ? [userId] : [userId, ...ids]
        )
        const marked = unread.map((row) => row.id)
        if (!marked.length) return marked
        yield* tx.execute(
          `UPDATE ${databaseTable("notification")}
              SET read_at = ?
            WHERE user_id = ? AND id IN (${marked.map(() => "?").join(", ")})`,
          [now, userId, ...marked]
        )
        return marked
      })
    )
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
