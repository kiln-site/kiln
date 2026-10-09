import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { NotificationsPage } from "@/components/notifications-page"
import { notificationsQueryOptions } from "@/lib/collections/notifications"
import { pageTitle } from "@/lib/page-title"
import { markNotificationsRead } from "@/server/notifications"

export const Route = createFileRoute("/_app/notifications")({
  // The notification the page opens at, from a click in the popover.
  validateSearch: z.object({ focus: z.uuid().optional() }),
  // Opening the page is reading the inbox. A hover preload only warms the
  // data; the router reruns this loader when the page actually opens.
  loader: async ({ context, preload }) => {
    const newIds = preload ? [] : await markNotificationsRead({ data: {} })
    const options = notificationsQueryOptions()
    if (newIds.length) {
      await context.queryClient.invalidateQueries({
        exact: true,
        queryKey: options.queryKey,
      })
    }
    await context.queryClient.ensureQueryData(options)
    return { newIds }
  },
  head: () => ({ meta: [{ title: pageTitle("Notifications") }] }),
  component: NotificationsRoute,
})

function NotificationsRoute() {
  const { newIds } = Route.useLoaderData()
  const { focus } = Route.useSearch()
  const highlighted = React.useMemo(() => new Set(newIds), [newIds])
  return <NotificationsPage focusId={focus ?? null} newIds={highlighted} />
}
