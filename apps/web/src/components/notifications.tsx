import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Bell,
  ExternalLink,
  PackageCheck,
  Rocket,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
  markNotificationsReadMutationOptions,
  notificationsQueryOptions,
  selectUnreadNotificationCount,
} from "@/lib/query-options"

interface NotificationsDialogStore {
  close: () => void
  getServerSnapshot: () => boolean
  getSnapshot: () => boolean
  open: () => void
  subscribe: (listener: () => void) => () => void
}

function createNotificationsDialogStore(): NotificationsDialogStore {
  let open = false
  const listeners = new Set<() => void>()
  const publish = (next: boolean) => {
    if (open === next) return
    open = next
    for (const listener of listeners) listener()
  }
  return {
    close: () => publish(false),
    getServerSnapshot: () => false,
    getSnapshot: () => open,
    open: () => publish(true),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const NotificationsDialogContext =
  React.createContext<NotificationsDialogStore | null>(null)

function useNotificationsDialogStore(): NotificationsDialogStore {
  const store = React.useContext(NotificationsDialogContext)
  if (!store) {
    throw new Error(
      "useNotificationsDialogStore must be used inside NotificationsDialogProvider"
    )
  }
  return store
}

// Triggers only read the stable store, so opening the dialog re-renders the
// dialog host alone, never the sidebar.
export const NotificationsDialogProvider = React.memo(
  function NotificationsDialogProvider({
    children,
  }: {
    children: React.ReactNode
  }) {
    const [store] = React.useState(createNotificationsDialogStore)
    return (
      <NotificationsDialogContext.Provider value={store}>
        {children}
        <NotificationsDialogHost store={store} />
      </NotificationsDialogContext.Provider>
    )
  }
)

function useUnreadNotificationCount(): number {
  const { data = 0 } = useQuery({
    ...notificationsQueryOptions(),
    select: selectUnreadNotificationCount,
  })
  return data
}

function unreadLabel(count: number) {
  return count === 0
    ? "Notifications"
    : `Notifications, ${count > 9 ? "more than 9" : count} unread`
}

/** The bell beside the Kiln name in the expanded sidebar. */
export const NotificationsBellButton = React.memo(
  function NotificationsBellButton({
    className,
    tooltipHidden,
  }: {
    className?: string
    tooltipHidden: boolean
  }) {
    const store = useNotificationsDialogStore()
    const unread = useUnreadNotificationCount()
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "relative grid size-7 shrink-0 place-items-center text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/45 focus-visible:outline-none",
              className
            )}
            aria-label={unreadLabel(unread)}
            onClick={store.open}
          >
            <Bell className="size-4" />
            {unread > 0 ? <UnreadDot className="top-1 right-1" /> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" hidden={tooltipHidden}>
          Notifications
        </TooltipContent>
      </Tooltip>
    )
  }
)

/** The Notifications entry in the collapsed sidebar's account menu. */
export const NotificationsMenuItem = React.memo(function NotificationsMenuItem({
  onSelect,
}: {
  onSelect: () => void
}) {
  const store = useNotificationsDialogStore()
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
      {unread > 0 ? (
        <span className="type-label min-w-5 rounded-md bg-primary/15 px-1 text-center text-primary tabular-nums">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </button>
  )
})

/** Marks the collapsed account avatar while anything is unread. */
export const UnreadNotificationsIndicator = React.memo(
  function UnreadNotificationsIndicator() {
    const unread = useUnreadNotificationCount()
    return unread > 0 ? <UnreadDot className="top-0.5 right-0.5" /> : null
  }
)

function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-1.5 rounded-full bg-primary ring-2 ring-sidebar",
        className
      )}
    />
  )
}

const NotificationsDialogHost = React.memo(function NotificationsDialogHost({
  store,
}: {
  store: NotificationsDialogStore
}) {
  const open = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) store.close()
    },
    [store]
  )
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <NotificationsPanel onNavigate={store.close} />
      </DialogContent>
    </Dialog>
  )
})

function showNotificationFailure(action: string) {
  return (error: Error) =>
    showToast({
      message: `Could not ${action}: ${error.message}`,
      type: "error",
    })
}

// Mounted only while the dialog is open. Opening it reads everything shown;
// rows that were unread keep their highlight until the dialog closes.
function NotificationsPanel({ onNavigate }: { onNavigate: () => void }) {
  const queryClient = useQueryClient()
  const { data: notifications, isPending } = useQuery(
    notificationsQueryOptions()
  )
  const { mutate: markRead } = useMutation(
    markNotificationsReadMutationOptions(queryClient)
  )
  const { mutate: dismiss } = useMutation(
    dismissNotificationMutationOptions(
      queryClient,
      showNotificationFailure("clear the notification")
    )
  )
  const { mutate: clear } = useMutation(
    clearNotificationsMutationOptions(
      queryClient,
      showNotificationFailure("clear notifications")
    )
  )
  const [highlighted, setHighlighted] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )

  const newestUnread = notifications?.find(
    (notification) => notification.readAt === null
  )
  React.useEffect(() => {
    if (!newestUnread || !notifications) return
    const unread = notifications.filter(
      (notification) => notification.readAt === null
    )
    setHighlighted((current) => {
      const next = new Set(current)
      for (const notification of unread) next.add(notification.id)
      return next
    })
    markRead(Math.max(...unread.map((notification) => notification.createdAt)))
  }, [markRead, newestUnread, notifications])

  const newest = notifications?.[0]
  return (
    <>
      <div className="flex h-13 items-center gap-2 border-b border-border/70 pr-12 pl-5">
        <DialogTitle className="flex-1">Notifications</DialogTitle>
        {newest ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => clear(newest.createdAt)}
          >
            Clear all
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          Loading notifications…
        </p>
      ) : !notifications?.length ? (
        <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
          <Bell className="size-5 text-muted-foreground/70" aria-hidden />
          <p className="text-sm font-medium">You're all caught up</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            New Kiln releases and changes to your access will show up here.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Notifications"
          className="max-h-[min(32rem,calc(100dvh-10rem))] overflow-y-auto py-1"
        >
          {notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              highlighted={highlighted.has(notification.id)}
              notification={notification}
              onDismiss={dismiss}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </>
  )
}

const NotificationRow = React.memo(function NotificationRow({
  highlighted,
  notification,
  onDismiss,
  onNavigate,
}: {
  highlighted: boolean
  notification: KilnNotification
  onDismiss: (id: string) => void
  onNavigate: () => void
}) {
  const { content } = notification
  const Icon = notificationIcons[content.kind]
  const title = notificationTitle(content)
  const url =
    content.kind === "kiln.release" || content.kind === "kiln.updated"
      ? content.url
      : null
  const body = (
    <>
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground",
          highlighted && "border-primary/30 bg-primary/10 text-primary"
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm leading-snug font-medium">
          {title}
          {url ? (
            <ExternalLink
              className="ml-1.5 inline size-3 -translate-y-px text-muted-foreground"
              aria-hidden
            />
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {notificationDetail(content)}
        </span>
        <time
          className="text-xs text-muted-foreground/75"
          dateTime={new Date(notification.createdAt).toISOString()}
          title={notificationDateFormatter.format(notification.createdAt)}
        >
          {formatRelative(notification.createdAt)}
        </time>
      </span>
      {highlighted ? (
        <span
          aria-label="Unread"
          className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
        />
      ) : null}
    </>
  )
  const contentClassName =
    "flex min-w-0 flex-1 items-start gap-3 py-3 pr-1 pl-5 text-left focus-visible:outline-none"

  return (
    <li
      className={cn(
        "flex items-start transition-colors has-[a:focus-visible]:bg-accent/60 has-[a:hover]:bg-accent/60",
        highlighted && "bg-primary/[0.04]"
      )}
    >
      {content.kind === "access.invited" ? (
        <Link
          to="/invite"
          search={{ id: content.invitationId }}
          className={contentClassName}
          onClick={onNavigate}
        >
          {body}
        </Link>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={contentClassName}
        >
          {body}
        </a>
      ) : (
        <div className={contentClassName}>{body}</div>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="mt-2.5 mr-3 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Clear "${title}"`}
        onClick={() => onDismiss(notification.id)}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  )
})

const notificationIcons = {
  "access.invited": UserPlus,
  "access.removed": UserMinus,
  "kiln.release": Rocket,
  "kiln.updated": PackageCheck,
} satisfies Record<
  NotificationContent["kind"],
  React.ComponentType<{
    className?: string
  }>
>

const resourceTypeLabels = {
  database: "database",
  instance: "server",
  relay: "Relay",
} satisfies Record<NotificationResource["type"], string>

function notificationTitle(content: NotificationContent): string {
  switch (content.kind) {
    case "kiln.release":
      return `Kiln ${content.version} is available`
    case "kiln.updated":
      return `Kiln was updated to ${content.version}`
    case "access.invited":
      return `${content.actorName} invited you to ${content.resource.name}`
    case "access.removed":
      return `You no longer have access to ${content.resource.name}`
  }
}

function notificationDetail(content: NotificationContent): string {
  switch (content.kind) {
    case "kiln.release":
      return "See what's new in the release notes."
    case "kiln.updated":
      return `Previously ${content.previousVersion}.`
    case "access.invited":
      return `Review the invitation to join this ${resourceTypeLabels[content.resource.type]}.`
    case "access.removed":
      return `${content.actorName} removed you from this ${resourceTypeLabels[content.resource.type]}.`
  }
}

const notificationDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
})

function formatRelative(value: number): string {
  const minutes = Math.round((Date.now() - value) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return relativeTimeFormatter.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return relativeTimeFormatter.format(-hours, "hour")
  const days = Math.round(hours / 24)
  if (days < 30) return relativeTimeFormatter.format(-days, "day")
  return notificationDateFormatter.format(value)
}
