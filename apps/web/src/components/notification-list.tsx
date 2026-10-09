import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
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

import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { RelativeTime } from "@/components/relative-time"
import {
  acceptedInvitationHref,
  useResourceInvitationDecision,
} from "@/components/resource-invitation-dialog"
import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
  setCachedInvitationOutcome,
} from "@/lib/collections/notifications"
import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { kilnReleaseLabel } from "@/lib/release-version"

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
 * Actions sit beside it, so a row never grows taller for them.
 */
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
  const detail = notificationDetail(content)

  return (
    <article
      aria-label={title}
      className={cn(
        "group/row flex items-center gap-3 py-2.5 pr-2 pl-4 transition-colors hover:bg-accent/50 has-[:focus-visible]:bg-accent/50",
        highlighted && "bg-primary/[0.04]",
        className
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground",
          highlighted && "border-primary/30 bg-primary/10 text-primary"
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm leading-snug font-medium" title={title}>
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
            className="shrink-0"
            timestamp={notification.createdAt}
          />
          {detail ? (
            <>
              <span aria-hidden className="opacity-60">
                ·
              </span>
              <span className="truncate" title={detail}>
                {detail}
              </span>
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
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
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
      return content.url ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <ChangelogLink url={content.url} />
        </div>
      ) : null
    case "kiln.release":
      return (
        <div className="flex shrink-0 items-center gap-1.5">
          <ChangelogLink url={content.url} />
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
  }
}

function ChangelogLink({ url }: { url: string }) {
  return (
    <Button
      asChild
      variant="ghost"
      size="xs"
      className="text-muted-foreground hover:text-foreground"
    >
      <a href={url} target="_blank" rel="noopener noreferrer">
        Changelog
        <ExternalLink data-icon="inline-end" aria-hidden />
      </a>
    </Button>
  )
}

// Opens the Updates dialog, where the update is reviewed and started.
function UpdateKilnButton({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const updateDialog = useInfraUpdateDialogStore()
  return (
    <Button
      size="xs"
      onClick={() => {
        onNavigate?.()
        void navigate({ to: "/infra/relays" }).then(() => updateDialog.open())
      }}
    >
      Update
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
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="xs"
        disabled={isPending}
        onClick={() => mutate("decline")}
      >
        {isPending && variables === "decline" ? "Declining…" : "Decline"}
      </Button>
      <Button size="xs" disabled={isPending} onClick={() => mutate("accept")}>
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
      className="shrink-0"
      onClick={() => {
        onNavigate?.()
        void navigate({
          href: acceptedInvitationHref(queryClient, {
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
  database: "Database",
  instance: "Server",
  relay: "Relay",
} satisfies Record<NotificationResource["type"], string>

// The release name GitHub gave the build, e.g. "v0.1.0 Nightly #17", or one
// made from its version for notifications written without it.
function releaseName(name: string | undefined, version: string) {
  return name ?? kilnReleaseLabel(version)
}

function notificationTitle(content: NotificationContent): string {
  switch (content.kind) {
    case "kiln.release":
      return `${releaseName(content.name, content.version)} available`
    case "kiln.updated":
      return `Updated to ${releaseName(content.name, content.version)}`
    case "access.invited": {
      const { actorName, resource } = content
      switch (content.outcome) {
        case undefined:
          return `${actorName} invited you to ${resource.name}`
        case "accepted":
          return `Joined ${resource.name}`
        case "declined":
          return `Declined ${actorName}'s invite to ${resource.name}`
        case "cancelled":
          return `${actorName}'s invite to ${resource.name} was cancelled`
      }
    }
    case "access.removed":
      return `Removed from ${content.resource.name}`
  }
}

function notificationDetail(content: NotificationContent): string | null {
  switch (content.kind) {
    case "kiln.release":
      return null
    case "kiln.updated":
      return `from ${releaseName(content.previousName, content.previousVersion)}`
    case "access.invited":
      return content.outcome === "accepted"
        ? `invited by ${content.actorName}`
        : resourceTypeLabels[content.resource.type]
    case "access.removed":
      return `by ${content.actorName}`
  }
}
