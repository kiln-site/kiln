import * as React from "react"
import { isNull, useLiveQuery } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bell } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  NotificationGroupLabel,
  NotificationRow,
  notificationListItems,
  useNotificationClearing,
} from "@/components/notification-list"
import {
  markCachedNotificationsRead,
  notificationsCollectionOptions,
  notificationsPopoverLimit,
} from "@/lib/collections/notifications"

interface NotificationsPopoverStore {
  close: () => void
  getHighlighted: () => ReadonlySet<string>
  getServerSnapshot: () => boolean
  getSnapshot: () => boolean
  open: () => void
  setOpen: (open: boolean) => void
  subscribe: (listener: () => void) => () => void
}

const noHighlights: ReadonlySet<string> = new Set()

// Opening the popover is the moment the user looks, so it marks the inbox
// read right there in the event, and remembers what was new to highlight it.
function createNotificationsPopoverStore(
  queryClient: QueryClient
): NotificationsPopoverStore {
  let open = false
  let highlighted = noHighlights
  const listeners = new Set<() => void>()
  const setOpen = (next: boolean) => {
    if (open === next) return
    if (next) highlighted = markCachedNotificationsRead(queryClient)
    open = next
    for (const listener of listeners) listener()
  }
  return {
    close: () => setOpen(false),
    getHighlighted: () => highlighted,
    getServerSnapshot: () => false,
    getSnapshot: () => open,
    open: () => setOpen(true),
    setOpen,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const NotificationsPopoverContext =
  React.createContext<NotificationsPopoverStore | null>(null)

function useNotificationsPopoverStore(): NotificationsPopoverStore {
  const store = React.useContext(NotificationsPopoverContext)
  if (!store) {
    throw new Error(
      "useNotificationsPopoverStore must be used inside NotificationsProvider"
    )
  }
  return store
}

function useNotificationsPopoverOpen(store: NotificationsPopoverStore) {
  return React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
}

// The bell and the collapsed account menu share one open state, so either can
// open the popover. Opening it re-renders the popover's owner alone, never the
// rest of the sidebar.
export const NotificationsProvider = React.memo(function NotificationsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const queryClient = useQueryClient()
  const [store] = React.useState(() =>
    createNotificationsPopoverStore(queryClient)
  )
  return (
    <NotificationsPopoverContext.Provider value={store}>
      {children}
    </NotificationsPopoverContext.Provider>
  )
})

function useUnreadNotificationIds(): ReadonlyArray<{ id: string }> {
  const { data } = useLiveQuery((query) =>
    query
      .from({ notification: notificationsCollectionOptions })
      .where(({ notification }) => isNull(notification.readAt))
      .select(({ notification }) => ({ id: notification.id }))
  )
  return data
}

function useUnreadNotificationCount(): number {
  return useUnreadNotificationIds().length
}

function unreadLabel(count: number) {
  return count === 0
    ? "Notifications"
    : `Notifications, ${count > 9 ? "more than 9" : count} unread`
}

/** The unread total in the accent color, shortened to 9+. */
function UnreadCountBadge({
  className,
  count,
}: {
  className?: string
  count: number
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] leading-none font-semibold text-primary-foreground tabular-nums",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  )
}

/** The bell beside the Kiln name in the expanded sidebar. */
export const NotificationsBell = React.memo(function NotificationsBell({
  className,
  tooltipHidden,
}: {
  className?: string
  tooltipHidden: boolean
}) {
  const store = useNotificationsPopoverStore()
  const open = useNotificationsPopoverOpen(store)
  const unread = useUnreadNotificationCount()
  return (
    <Popover open={open} onOpenChange={store.setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
                className
              )}
              aria-label={unreadLabel(unread)}
            >
              <Bell className={cn("size-4", unread > 0 && "text-primary")} />
              {unread > 0 ? (
                <UnreadCountBadge
                  count={unread}
                  className="absolute -top-1 -right-1.5 ring-2 ring-sidebar"
                />
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="center"
          hidden={tooltipHidden || open}
        >
          Notifications
        </TooltipContent>
      </Tooltip>
      <NotificationsPopoverContent align="start" />
    </Popover>
  )
})

/**
 * Anchors the popover to the collapsed sidebar's account avatar, where the
 * account menu's Notifications item opens it.
 */
export const CollapsedNotificationsAnchor = React.memo(
  function CollapsedNotificationsAnchor({
    children,
  }: {
    children: React.ReactNode
  }) {
    const store = useNotificationsPopoverStore()
    const open = useNotificationsPopoverOpen(store)
    return (
      <Popover open={open} onOpenChange={store.setOpen}>
        <PopoverAnchor className="grid">{children}</PopoverAnchor>
        <NotificationsPopoverContent align="end" />
      </Popover>
    )
  }
)

/** The Notifications entry in the collapsed sidebar's account menu. */
export const NotificationsMenuItem = React.memo(function NotificationsMenuItem({
  onSelect,
}: {
  onSelect: () => void
}) {
  const store = useNotificationsPopoverStore()
  const unread = useUnreadNotificationCount()
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 px-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
      aria-label={unreadLabel(unread)}
      onClick={() => {
        onSelect()
        store.open()
      }}
    >
      <Bell className="size-4" />
      <span className="flex-1">Notifications</span>
      {unread > 0 ? <UnreadCountBadge count={unread} /> : null}
    </button>
  )
})

/** The unread total on the collapsed sidebar's account avatar. */
export const UnreadNotificationsIndicator = React.memo(
  function UnreadNotificationsIndicator() {
    const unread = useUnreadNotificationCount()
    return unread > 0 ? (
      <UnreadCountBadge
        count={unread}
        className="pointer-events-none absolute -top-1 -right-1.5 ring-2 ring-sidebar"
      />
    ) : null
  }
)

function NotificationsPopoverContent({ align }: { align: "start" | "end" }) {
  const store = useNotificationsPopoverStore()
  // Following a link moves focus to the new page; returning it to the bell
  // would pop the bell's tooltip over that page.
  const navigatedRef = React.useRef(false)
  const navigate = React.useCallback(() => {
    navigatedRef.current = true
    store.close()
  }, [store])
  const handleCloseAutoFocus = React.useCallback((event: Event) => {
    if (navigatedRef.current) event.preventDefault()
    navigatedRef.current = false
  }, [])
  return (
    <PopoverContent
      aria-label="Notifications"
      side="right"
      align={align}
      sideOffset={10}
      collisionPadding={8}
      className="flex w-[min(26rem,calc(100vw-1rem))] flex-col p-0"
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <NotificationsPopoverPanel onNavigate={navigate} />
    </PopoverContent>
  )
}

// Mounted only while the popover is open, so a closed popover never renders
// the list.
function NotificationsPopoverPanel({ onNavigate }: { onNavigate: () => void }) {
  const store = useNotificationsPopoverStore()
  const highlighted = React.useSyncExternalStore(
    store.subscribe,
    store.getHighlighted,
    store.getHighlighted
  )
  const { data: notifications, isLoading } = useLiveQuery((query) =>
    query
      .from({ notification: notificationsCollectionOptions })
      .orderBy(({ notification }) => notification.createdAt, "desc")
      .orderBy(({ notification }) => notification.id, "desc")
      .limit(notificationsPopoverLimit)
  )
  const unread = useUnreadNotificationIds()
  const { clearThrough, dismiss } = useNotificationClearing()
  const newest = notifications[0]
  // What was new when it opened, plus anything still unread: newer arrivals
  // and older rows below the ones shown.
  const newCount =
    highlighted.size + unread.filter(({ id }) => !highlighted.has(id)).length

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-2 pl-4">
        <h2 className="text-sm font-semibold">Notifications</h2>
        {newCount > 0 ? <UnreadCountBadge count={newCount} /> : null}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          disabled={!newest}
          onClick={() => newest && clearThrough(newest.createdAt)}
        >
          Clear all
        </Button>
      </div>
      {/* A fixed height, about four and a half rows, so the popover never
          resizes and a cut-off row shows there's more. */}
      <div
        role="feed"
        aria-label="Latest notifications"
        aria-busy={isLoading}
        className="h-[20.5rem] overflow-y-auto overscroll-contain"
      >
        {isLoading ? (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            Loading notifications…
          </p>
        ) : notifications.length ? (
          notificationListItems(notifications).map((item) =>
            item.kind === "group" ? (
              <NotificationGroupLabel
                key={item.key}
                className="sticky top-0 z-10"
                label={item.label}
              />
            ) : (
              <NotificationRow
                key={item.key}
                className="border-b border-border/60 last:border-b-0"
                highlighted={
                  highlighted.has(item.notification.id) ||
                  item.notification.readAt === null
                }
                notification={item.notification}
                onDismiss={dismiss}
                onNavigate={onNavigate}
              />
            )
          )
        ) : (
          <NotificationsEmptyState />
        )}
      </div>
      <Link
        to="/notifications"
        className="flex h-10 shrink-0 items-center justify-center border-t border-border/70 text-sm font-medium text-primary transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
        onClick={onNavigate}
      >
        View all notifications
      </Link>
    </>
  )
}

export function NotificationsEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Bell className="size-5 text-muted-foreground/70" aria-hidden />
      <p className="text-sm font-medium">You're all caught up</p>
    </div>
  )
}
