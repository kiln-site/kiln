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

import { RelativeTime } from "@/components/relative-time"
import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
} from "@/lib/collections/notifications"
import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"

export type NotificationListItem =
  | { key: string; kind: "group"; label: string }
  | { key: string; kind: "notification"; notification: KilnNotification }

/**
 * Notifications, newest first, under Today, Yesterday, and Older labels. Empty
 * groups are left out.
 */
export function notificationListItems(
  notifications: ReadonlyArray<KilnNotification>
): Array<NotificationListItem> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()
  const yesterdayStart = todayStart - 86_400_000
  const items: Array<NotificationListItem> = []
  let label: string | null = null
  for (const notification of notifications) {
    const nextLabel =
      notification.createdAt >= todayStart
        ? "Today"
        : notification.createdAt >= yesterdayStart
          ? "Yesterday"
          : "Older"
    if (nextLabel !== label) {
      label = nextLabel
      items.push({ key: `group:${label}`, kind: "group", label })
    }
    items.push({ key: notification.id, kind: "notification", notification })
  }
  return items
}

export const NotificationGroupLabel = React.memo(
  function NotificationGroupLabel({
    className,
    label,
  }: {
    className?: string
    label: string
  }) {
    return (
      <h3
        className={cn(
          "type-technical-label border-b border-border/60 bg-muted/85 px-4 py-1.5 text-muted-foreground backdrop-blur-sm",
          className
        )}
      >
        {label}
      </h3>
    )
  }
)

export const NotificationRow = React.memo(function NotificationRow({
  className,
  highlighted,
  notification,
  onDismiss,
  onNavigate,
}: {
  className?: string
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
      </span>
      <span className="flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground">
        {highlighted ? (
          <span
            aria-label="Unread"
            className="size-1.5 rounded-full bg-primary"
          />
        ) : null}
        <RelativeTime timestamp={notification.createdAt} />
      </span>
    </>
  )
  const contentClassName =
    "flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left focus-visible:outline-none"

  return (
    <article
      aria-label={title}
      className={cn(
        "group/row flex transition-colors hover:bg-accent/50 has-[a:focus-visible]:bg-accent/50",
        highlighted && "bg-primary/[0.04]",
        className
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
        size="icon-xs"
        className="mr-2 ml-1 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Clear "${title}"`}
        onClick={() => onDismiss(notification.id)}
      >
        <X />
      </Button>
    </article>
  )
})

function showNotificationFailure(action: string) {
  return (error: Error) =>
    showToast({
      message: `Could not ${action}: ${error.message}`,
      type: "error",
    })
}

/** Clearing one notification, or everything up to the newest one shown. */
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
