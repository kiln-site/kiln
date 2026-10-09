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
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 px-3 py-4 sm:px-5 sm:py-5">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={!newest}
          onClick={() => newest && clearThrough(newest.createdAt)}
        >
          Clear all
        </Button>
      </div>
      {/* Fills the page whatever it holds, and scrolls inside. */}
      <section
        aria-label="Notifications"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-xl border bg-card/45"
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
