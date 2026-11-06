import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { NotificationsPage } from "@/components/notifications-page"
import { notificationsQueryOptions } from "@/lib/collections/notifications"
import { pageTitle } from "@/lib/page-title"
import { markNotificationsRead } from "@/server/notifications"

export const Route = createFileRoute("/_app/notifications")({
  // The notification the page opens at, for one with no page of its own.
  validateSearch: z.object({ focus: z.uuid().optional() }),
  loaderDeps: ({ search }) => ({ focus: search.focus }),
  // Opening the page is reading the inbox, and opening it at a notification
  // is reading that one. A hover preload only warms the data; the router
  // reruns this loader when the page actually opens.
  loader: async ({ context, deps, preload }) => {
    const newIds = preload
      ? []
      : await markNotificationsRead({
          data: deps.focus ? { ids: [deps.focus] } : {},
        })
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
