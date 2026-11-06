import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { notificationsQueryOptions } from "@/lib/collections/notifications"
import { notificationDestination } from "@/lib/notification-links"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { markNotificationsRead } from "@/server/notifications"

// Where a push notification leads, since a device can't tell Kiln it was
// tapped: this reads that one notification, then opens what it's about.
export const Route = createFileRoute("/_app/notifications_/$notificationId")({
  params: {
    parse: (params) => z.object({ notificationId: z.uuid() }).parse(params),
  },
  loader: async ({ context, params, preload }) => {
    if (preload) return
    const { queryClient } = context
    const options = notificationsQueryOptions()
    const inbox = await queryClient.fetchQuery(options)
    const notification = inbox.find(({ id }) => id === params.notificationId)
    // Cleared or replaced since it was pushed. Opening the inbox at it, it's
    // no longer there, so the rest stay unread.
    if (!notification)
      throw redirect({
        search: { focus: params.notificationId },
        to: "/notifications",
      })
    const capabilities = await queryClient.ensureQueryData(
      accessCapabilitiesQueryOptions()
    )
    if (notification.readAt === null) {
      await markNotificationsRead({ data: { ids: [notification.id] } })
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: options.queryKey,
      })
    }
    throw redirect({
      href: notificationDestination(notification, capabilities.isPlatformAdmin),
    })
  },
})
