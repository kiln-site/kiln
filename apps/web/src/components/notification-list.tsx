import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  CloudUpload,
  HardDrive,
  PackageCheck,
  PackagePlus,
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
  acceptedInvitationHref,
  useResourceInvitationDecision,
} from "@/components/resource-invitation-dialog"
import { appRouteIdentifier } from "@/lib/app-route"
import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
  notificationsQueryOptions,
  setCachedInvitationOutcome,
} from "@/lib/collections/notifications"
import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { notificationDetail, notificationTitle } from "@/lib/notification-text"
import { appDirectoryQueryOptions } from "@/lib/query-options"

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

/**
 * One notification in two lines: what happened, then when plus one detail.
 * Actions sit beside it, so a row never grows taller for them. In the popover
 * the row opens the notifications page at itself; the page has room for a
 * second line of title, and marks the notification it was opened at.
 */
export const NotificationRow = React.memo(function NotificationRow({
  className,
  focused = false,
  highlighted,
  notification,
  onDismiss,
  onNavigate,
  variant,
}: {
  className?: string
  focused?: boolean
  highlighted: boolean
  notification: KilnNotification
  onDismiss: (id: string) => void
  onNavigate?: () => void
  variant: "page" | "popover"
}) {
  const { content } = notification
  const Icon = notificationIcons[content.kind]
  const title = notificationTitle(content)
  const detail = notificationDetail(content)

  return (
    <article
      aria-label={title}
      className={cn(
        "group/row relative flex items-center gap-3 py-2.5 pr-2 pl-4 transition-colors hover:bg-accent/50 has-[:focus-visible]:bg-accent/50",
        highlighted && "bg-primary/[0.04]",
        focused &&
          "bg-accent/40 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        className
      )}
    >
      {variant === "popover" ? (
        // Covers the row; the actions and time sit above it.
        <Link
          to="/notifications"
          search={{ focus: notification.id }}
          aria-label={title}
          title={title}
          className="absolute inset-0 focus-visible:outline-none"
          onClick={onNavigate}
        />
      ) : null}
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground",
          highlighted && "border-primary/30 bg-primary/10 text-primary-ink"
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "text-sm leading-snug font-medium",
            variant === "page" ? "line-clamp-2 break-words" : "truncate"
          )}
          title={variant === "page" ? title : undefined}
        >
          {title}
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {highlighted ? (
            <span
              aria-label="Unread"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          ) : null}
          <RelativeTime
            className="relative shrink-0"
            timestamp={notification.createdAt}
          />
          {detail ? (
            <>
              <span aria-hidden className="opacity-60">
                ·
              </span>
              <span className="truncate">{detail}</span>
            </>
          ) : null}
        </p>
      </div>
      <NotificationActions
        notificationId={notification.id}
        content={content}
        onNavigate={onNavigate}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        className="relative -ml-2 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Clear "${title}"`}
        onClick={() => onDismiss(notification.id)}
      >
        <X />
      </Button>
    </article>
  )
})

function NotificationActions({
  content,
  notificationId,
  onNavigate,
}: {
  content: NotificationContent
  notificationId: string
  onNavigate?: () => void
}) {
  switch (content.kind) {
    case "kiln.updated":
      return (
        <div className="relative flex shrink-0 items-center gap-1.5">
          <ChangelogLink onNavigate={onNavigate} />
        </div>
      )
    case "kiln.release":
      return (
        <div className="relative flex shrink-0 items-center gap-1.5">
          <ChangelogLink onNavigate={onNavigate} />
          <UpdateKilnButton onNavigate={onNavigate} />
        </div>
      )
    case "access.invited":
      return content.outcome === undefined ? (
        <InvitationActions
          invitationId={content.invitationId}
          notificationId={notificationId}
        />
      ) : content.outcome === "accepted" ? (
        <OpenResourceButton
          resource={content.resource}
          onNavigate={onNavigate}
        />
      ) : null
    case "access.removed":
      return null
    case "resource.disk-limit":
    case "app.image-update":
    case "app.deployed":
      return (
        <OpenResourceButton
          resource={content.resource}
          onNavigate={onNavigate}
        />
      )
  }
}

// Opens the Updates dialog's changelog.
function ChangelogLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Button asChild variant="outline" size="xs">
      <Link to="/infra/updates/changelog" onClick={onNavigate}>
        Changelog
      </Link>
    </Button>
  )
}

// Opens the Updates dialog, where the update is reviewed and started.
function UpdateKilnButton({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Button asChild size="xs">
      <Link to="/infra/updates" onClick={onNavigate}>
        Update
      </Link>
    </Button>
  )
}

function InvitationActions({
  invitationId,
  notificationId,
}: {
  invitationId: string
  notificationId: string
}) {
  const queryClient = useQueryClient()
  const { isPending, mutate, variables } = useResourceInvitationDecision(
    invitationId,
    (accepted) =>
      setCachedInvitationOutcome(
        queryClient,
        notificationId,
        accepted ? "accepted" : "declined"
      )
  )
  // A failed answer usually means the invitation changed meanwhile; reload
  // the inbox so the row shows what happened to it.
  const answer = (decision: "accept" | "decline") =>
    mutate(decision, {
      onError: () =>
        void queryClient.invalidateQueries({
          queryKey: notificationsQueryOptions().queryKey,
        }),
    })
  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="xs"
        disabled={isPending}
        onClick={() => answer("decline")}
      >
        {isPending && variables === "decline" ? "Declining…" : "Decline"}
      </Button>
      <Button size="xs" disabled={isPending} onClick={() => answer("accept")}>
        {isPending && variables === "accept" ? "Accepting…" : "Accept"}
      </Button>
    </div>
  )
}

function OpenResourceButton({
  onNavigate,
  resource,
}: {
  onNavigate?: () => void
  resource: NotificationResource
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return (
    <Button
      variant="outline"
      size="xs"
      className="relative shrink-0"
      onClick={() => {
        onNavigate?.()
        void navigate({
          href:
            resource.type === "app"
              ? appHref(queryClient, resource.id)
              : acceptedInvitationHref(queryClient, {
                  relayId: resource.relayId,
                  resourceId: resource.id,
                  resourceType: resource.type,
                }),
        })
      }}
    >
      Open
    </Button>
  )
}

// The app's own page, by its short ID when the cached directory can tell it
// apart. The route resolves a full ID too, and falls back to the Apps list for
// an app that's gone.
function appHref(queryClient: QueryClient, appId: string) {
  const apps = queryClient.getQueryData(appDirectoryQueryOptions().queryKey)
  const routeId = apps ? appRouteIdentifier(apps, { id: appId }) : appId
  return `/app/${encodeURIComponent(routeId)}`
}

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
  "resource.disk-limit": HardDrive,
  "app.image-update": PackagePlus,
  "app.deployed": CloudUpload,
} satisfies Record<
  NotificationContent["kind"],
  React.ComponentType<{ className?: string }>
>
