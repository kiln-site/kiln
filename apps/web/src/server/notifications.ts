import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  listNotificationsEffect,
  markNotificationsReadEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"

// Notifications are addressed to one user, so every read and write is keyed
// by the signed-in user's ID and never by input.
export const getNotifications = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    return runAppEffect("notifications.list", listNotificationsEffect(user.id))
  }
)

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
