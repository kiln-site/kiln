import * as React from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import type { Range } from "@tanstack/react-virtual"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

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
  // The day label above the visible rows stays rendered and pins to the top,
  // like the popover's labels; the next label scrolls up over it.
  const groupIndexes = React.useMemo(
    () =>
      items.flatMap((item, index) => (item.kind === "group" ? [index] : [])),
    [items]
  )
  const pinnedIndexRef = React.useRef(0)
  const rangeExtractor = React.useCallback(
    (range: Range) => {
      let pinned = 0
      for (const index of groupIndexes) {
        if (index > range.startIndex) break
        pinned = index
      }
      pinnedIndexRef.current = pinned
      return [
        ...new Set([pinnedIndexRef.current, ...defaultRangeExtractor(range)]),
      ].sort((left, right) => left - right)
    },
    [groupIndexes]
  )
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => (items[index]?.kind === "group" ? 29 : 62),
    getItemKey: (index) => items[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    overscan: 10,
    rangeExtractor,
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
              const pinned =
                item.kind === "group" &&
                virtualItem.index === pinnedIndexRef.current
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className={cn(
                    "inset-x-0 top-0",
                    pinned ? "sticky z-10" : "absolute",
                    item.kind === "group" && "z-10"
                  )}
                  style={
                    pinned
                      ? undefined
                      : { transform: `translateY(${virtualItem.start}px)` }
                  }
                >
                  {item.kind === "group" ? (
                    <NotificationGroupLabel label={item.label} />
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
