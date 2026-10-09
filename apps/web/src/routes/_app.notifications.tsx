import { createFileRoute } from "@tanstack/react-router"

import { NotificationsPage } from "@/components/notifications-page"
import { notificationsPageQueryOptions } from "@/lib/notification-queries"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/notifications")({
  loader: ({ context }) =>
    context.queryClient.ensureInfiniteQueryData(
      notificationsPageQueryOptions()
    ),
  head: () => ({ meta: [{ title: pageTitle("Notifications") }] }),
  component: NotificationsPage,
})
