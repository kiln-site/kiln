import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  clearNotificationsEffect,
  countUnreadNotificationsEffect,
  dismissNotificationEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { runAppEffect } from "@/effect/runtime"
import {
  notificationCursorSchema,
  notificationInboxLimit,
  notificationPageSize,
  type NotificationInbox,
} from "@/lib/notifications"
import { requireEligibleResourceUser } from "@/server/auth"

// Notifications are addressed to one user, so every read and write is keyed
// by the signed-in user's ID and never by input.

/** The newest notifications and the unread total, for the sidebar. */
export const getNotificationInbox = createServerFn({ method: "GET" }).handler(
  async (): Promise<NotificationInbox> => {
    const user = await requireEligibleResourceUser()
    const [page, unreadCount] = await Promise.all([
      runAppEffect(
        "notifications.inbox",
        listNotificationsEffect(user.id, notificationInboxLimit)
      ),
      runAppEffect(
        "notifications.countUnread",
        countUnreadNotificationsEffect(user.id)
      ),
    ])
    return { notifications: page.notifications, unreadCount }
  }
)

export const getNotificationsPage = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({
      before: notificationCursorSchema.nullable().default(null),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return runAppEffect(
      "notifications.page",
      listNotificationsEffect(
        user.id,
        notificationPageSize,
        data.before ?? undefined
      )
    )
  })

export const markNotificationsRead = createServerFn({ method: "POST" })
  .validator(z.strictObject({ through: z.number().int().nonnegative() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const marked = await runAppEffect(
      "notifications.markRead",
      markNotificationsReadEffect(user.id, data.through)
    )
    if (marked > 0) publishNotificationChange([user.id])
  })

export const dismissNotification = createServerFn({ method: "POST" })
  .validator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const dismissed = await runAppEffect(
      "notifications.dismiss",
      dismissNotificationEffect(user.id, data.id)
    )
    if (dismissed > 0) publishNotificationChange([user.id])
  })

export const clearNotifications = createServerFn({ method: "POST" })
  .validator(z.strictObject({ through: z.number().int().nonnegative() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const cleared = await runAppEffect(
      "notifications.clear",
      clearNotificationsEffect(user.id, data.through)
    )
    if (cleared > 0) publishNotificationChange([user.id])
  })
