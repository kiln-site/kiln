import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  clearNotificationsEffect,
  dismissNotificationEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { runAppEffect } from "@/effect/runtime"
import { notificationHistoryLimit } from "@/lib/notifications"
import { requireEligibleResourceUser } from "@/server/auth"

// Notifications are addressed to one user, so every read and write is keyed
// by the signed-in user's ID and never by input.

export const getNotifications = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    return runAppEffect("notifications.list", listNotificationsEffect(user.id))
  }
)

/** Marks the given notifications read, or every unread one without `ids`. */
export const markNotificationsRead = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      ids: z.array(z.uuid()).min(1).max(notificationHistoryLimit).optional(),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const marked = await runAppEffect(
      "notifications.markRead",
      markNotificationsReadEffect(user.id, data.ids ?? "all")
    )
    if (marked.length) publishNotificationChange([user.id])
    return marked
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

/** Clears everything created at or before `through`, the newest one seen. */
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
