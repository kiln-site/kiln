import * as React from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Button } from "@workspace/ui/components/button"

import {
  NotificationGroupLabel,
  NotificationRow,
  notificationListItems,
  useNotificationClearing,
} from "@/components/notification-list"
import { NotificationsEmptyState } from "@/components/notifications"
import { notificationsCollectionOptions } from "@/lib/collections/notifications"

/**
 * The full history, virtualized. `newIds` are the notifications that were
 * unread when the page opened, kept highlighted while it stays open.
 */
export function NotificationsPage({ newIds }: { newIds: ReadonlySet<string> }) {
  const { data: notifications, isLoading } = useLiveQuery((query) =>
    query
      .from({ notification: notificationsCollectionOptions })
      .orderBy(({ notification }) => notification.createdAt, "desc")
      .orderBy(({ notification }) => notification.id, "desc")
  )
  const items = React.useMemo(
    () => notificationListItems(notifications),
    [notifications]
  )
  const { dismiss } = useNotificationClearing()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => (items[index]?.kind === "group" ? 29 : 66),
    getItemKey: (index) => items[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: 10,
  })

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-3 py-4 sm:px-5 sm:py-5">
      {/* Fills the page whatever it holds, and scrolls inside. */}
      <div
        ref={scrollRef}
        role="feed"
        aria-label="Notifications"
        aria-busy={isLoading}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border bg-card/45"
      >
        {items.length ? (
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = items[virtualItem.index]
              if (!item) return null
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {item.kind === "group" ? (
                    <NotificationGroupLabel
                      className={virtualItem.index === 0 ? "" : "border-t"}
                      label={item.label}
                    />
                  ) : (
                    <NotificationRow
                      className="border-b border-border/60"
                      highlighted={
                        newIds.has(item.notification.id) ||
                        item.notification.readAt === null
                      }
                      notification={item.notification}
                      onDismiss={dismiss}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : isLoading ? null : (
          <NotificationsEmptyState />
        )}
      </div>
    </div>
  )
}

/** Clear all, in the page header beside the title. */
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
