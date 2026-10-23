import { createFileRoute } from "@tanstack/react-router"

import { NotificationSettingsPage } from "@/components/notification-settings-page"
import { notificationPreferencesQueryOptions } from "@/lib/collections/notifications"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/settings/notifications")({
  head: () => ({ meta: [{ title: pageTitle("Notification Settings") }] }),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(notificationPreferencesQueryOptions()),
  component: NotificationSettingsRoute,
})

function NotificationSettingsRoute() {
  return <NotificationSettingsPage />
}
