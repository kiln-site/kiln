import { useInfiniteQuery } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  NotificationList,
  useHighlightUnread,
  useNotificationClearing,
} from "@/components/notification-list"
import { NotificationsEmptyState } from "@/components/notifications"
import { notificationsPageQueryOptions } from "@/lib/notification-queries"

export function NotificationsPage() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      ...notificationsPageQueryOptions(),
      select: (pages) => pages.pages.flatMap((page) => page.notifications),
    })
  const notifications = data ?? []
  const highlighted = useHighlightUnread(data)
  const { clearThrough, dismiss } = useNotificationClearing()
  const newest = notifications[0]

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-3 py-4 sm:px-5 sm:py-5">
      <div className="flex min-h-8 items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          Kiln releases, updates, and changes to your access.
        </p>
        {newest ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => clearThrough(newest.createdAt)}
          >
            Clear all
          </Button>
        ) : null}
      </div>
      <section
        aria-label="Notifications"
        className="min-w-0 rounded-xl border bg-card/45"
      >
        {notifications.length ? (
          <NotificationList
            className="[&>section:first-child>h3]:rounded-t-xl"
            highlighted={highlighted}
            notifications={notifications}
            onDismiss={dismiss}
          />
        ) : (
          <NotificationsEmptyState />
        )}
        {hasNextPage ? (
          <div className="border-t border-border/60 p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground hover:text-foreground"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              {isFetchingNextPage ? "Loading" : "Load older notifications"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
