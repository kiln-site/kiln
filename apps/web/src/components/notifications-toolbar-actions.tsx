import * as React from "react"
import { useLiveQuery } from "@tanstack/react-db"

import { Button } from "@workspace/ui/components/button"

import { useNotificationClearing } from "@/components/notification-list"
import { notificationsCollectionOptions } from "@/lib/collections/notifications"

// Separate from the page, so every page's toolbar does not load it.
export const NotificationsToolbarActions = React.memo(
  function NotificationsToolbarActions() {
    const { data: newest } = useLiveQuery((query) =>
      query
        .from({ notification: notificationsCollectionOptions })
        .orderBy(({ notification }) => notification.createdAt, "desc")
        .limit(1)
        .select(({ notification }) => ({ createdAt: notification.createdAt }))
    )
    const { clearThrough } = useNotificationClearing()
    const through = newest[0]?.createdAt
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={through === undefined}
        onClick={() => through !== undefined && clearThrough(through)}
      >
        Clear all
      </Button>
    )
  }
)
