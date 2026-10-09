import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ExternalLink,
  PackageCheck,
  Rocket,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
  markNotificationsReadMutationOptions,
} from "@/lib/notification-queries"
import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"

/** Notifications grouped under day labels, newest first. */
export function NotificationList({
  className,
  highlighted,
  notifications,
  onDismiss,
  onNavigate,
}: {
  className?: string
  highlighted: ReadonlySet<string>
  notifications: ReadonlyArray<KilnNotification>
  onDismiss: (id: string) => void
  onNavigate?: () => void
}) {
  return (
    <div className={className}>
      {groupByDay(notifications).map((group) => (
        <section key={group.key}>
          <h3 className="type-technical-label sticky top-0 z-10 border-b border-border/60 bg-muted/85 px-4 py-1.5 text-muted-foreground backdrop-blur-sm">
            {group.label}
          </h3>
          <ul className="divide-y divide-border/60">
            {group.notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                highlighted={highlighted.has(notification.id)}
                notification={notification}
                onDismiss={onDismiss}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
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
  onNavigate?: () => void
}) {
  const { content } = notification
  const Icon = notificationIcons[content.kind]
  const title = notificationTitle(content)
  const url =
    content.kind === "kiln.release" || content.kind === "kiln.updated"
      ? content.url
      : null
  const time = (
    <>
      {highlighted ? (
        <span
          aria-label="Unread"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      <time
        dateTime={new Date(notification.createdAt).toISOString()}
        title={notificationDateFormatter.format(notification.createdAt)}
      >
        {formatNotificationTime(notification.createdAt)}
      </time>
    </>
  )
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
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1 text-sm leading-snug font-medium [@media(hover:none)]:pr-7">
            {title}
            {url ? (
              <ExternalLink
                className="ml-1.5 inline size-3 -translate-y-px text-muted-foreground"
                aria-hidden
              />
            ) : null}
          </span>
          {/* Hover swaps the time for the clear button; touch shows both. */}
          <span className="flex shrink-0 items-center gap-1.5 pt-px text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0 [@media(hover:none)]:hidden">
            {time}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {notificationDetail(content)}
        </span>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground/75 [@media(hover:none)]:flex">
          {time}
        </span>
      </span>
    </>
  )
  const rowClassName = cn(
    "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors group-hover/row:bg-accent/50 focus-visible:outline-none",
    highlighted && "bg-primary/[0.04]"
  )

  return (
    <li className="group/row relative">
      {content.kind === "access.invited" ? (
        <Link
          to="/invite"
          search={{ id: content.invitationId }}
          className={cn(rowClassName, "focus-visible:bg-accent/50")}
          onClick={onNavigate}
        >
          {body}
        </Link>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(rowClassName, "focus-visible:bg-accent/50")}
        >
          {body}
        </a>
      ) : (
        <div className={rowClassName}>{body}</div>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-2.5 right-3 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Clear "${title}"`}
        onClick={() => onDismiss(notification.id)}
      >
        <X />
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
  React.ComponentType<{ className?: string }>
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
const notificationClockFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: "short",
})
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "short",
})
const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
})
const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
})
const fullDayFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
})

// The day label carries the date, so rows only need the time of day.
function formatNotificationTime(value: number): string {
  const minutes = Math.floor((Date.now() - value) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return relativeTimeFormatter.format(-minutes, "minute")
  return notificationClockFormatter.format(value)
}

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayLabel(dayStart: number, todayStart: number): string {
  const days = Math.round((todayStart - dayStart) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return weekdayFormatter.format(dayStart)
  return new Date(dayStart).getFullYear() === new Date(todayStart).getFullYear()
    ? monthDayFormatter.format(dayStart)
    : fullDayFormatter.format(dayStart)
}

function groupByDay(notifications: ReadonlyArray<KilnNotification>) {
  const todayStart = startOfDay(Date.now())
  const groups: Array<{
    key: number
    label: string
    notifications: Array<KilnNotification>
  }> = []
  for (const notification of notifications) {
    const key = startOfDay(notification.createdAt)
    const group = groups.at(-1)
    if (group?.key === key) group.notifications.push(notification)
    else
      groups.push({
        key,
        label: dayLabel(key, todayStart),
        notifications: [notification],
      })
  }
  return groups
}

/**
 * Reads what the user is looking at. Rows that were unread stay highlighted
 * for as long as the view is mounted, so the user can still tell them apart.
 */
export function useHighlightUnread(
  notifications: ReadonlyArray<KilnNotification> | undefined
): ReadonlySet<string> {
  const queryClient = useQueryClient()
  const { mutate: markRead } = useMutation(
    markNotificationsReadMutationOptions(queryClient)
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
    markRead(newestUnread.createdAt)
  }, [markRead, newestUnread, notifications])
  return highlighted
}

function showNotificationFailure(action: string) {
  return (error: Error) =>
    showToast({
      message: `Could not ${action}: ${error.message}`,
      type: "error",
    })
}

/** Clearing one notification, or everything created at or before a time. */
export function useNotificationClearing() {
  const queryClient = useQueryClient()
  const { mutate: dismiss } = useMutation(
    dismissNotificationMutationOptions(
      queryClient,
      showNotificationFailure("clear the notification")
    )
  )
  const { mutate: clearThrough } = useMutation(
    clearNotificationsMutationOptions(
      queryClient,
      showNotificationFailure("clear notifications")
    )
  )
  return { clearThrough, dismiss }
}
