import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  ArrowRightLeft,
  ChevronDown,
  CloudUpload,
  HardDrive,
  PackageCheck,
  PackagePlus,
  Rocket,
  ShieldAlert,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { RelativeTime } from "@/components/relative-time"
import { ServerDeleteDialog } from "@/components/server-delete-dialog"
import {
  notificationCommands,
  type NotificationCommand,
} from "@/components/notification-commands"
import {
  clearNotificationsMutationOptions,
  dismissNotificationMutationOptions,
  markCachedNotificationRead,
} from "@/lib/collections/notifications"
import {
  notificationDestination,
  notificationResourceHref,
} from "@/lib/notification-links"
import type {
  KilnNotification,
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import {
  notificationDetail,
  notificationTitle,
  resourceTypeLabels,
} from "@/lib/notification-text"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

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
 * Actions sit beside it, so a row never grows taller for them. The row opens
 * what it's about, or the page at itself if it's about nothing that can be
 * opened. The page has room for a second line of title, and marks the
 * notification it was opened at.
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
  const platformAdmin = usePlatformAdmin()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const destination = notificationDestination(notification, platformAdmin)

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
      {/* Covers the row; the actions and time sit above it. A new tab goes
          through the route that reads it, and this one reads it here, since
          a row can arrive while the list is open. */}
      <a
        href={`/notifications/${notification.id}`}
        aria-label={title}
        title={title}
        className="absolute inset-0 focus-visible:outline-none"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return
          event.preventDefault()
          markOpened(queryClient, notification)
          onNavigate?.()
          void navigate({ href: destination })
        }}
      />
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
        notification={notification}
        onNavigate={onNavigate}
      />
      {/* Always here, so every row's actions end at the same place. */}
      <Button
        variant="ghost"
        size="icon-xs"
        className="relative -ml-1.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Clear "${title}"`}
        onClick={() => onDismiss(notification.id)}
      >
        <X />
      </Button>
    </article>
  )
})

// Acting on a notification is reading it, this one alone.
function markOpened(queryClient: QueryClient, notification: KilnNotification) {
  if (notification.readAt === null)
    markCachedNotificationRead(queryClient, notification.id)
}

function usePlatformAdmin() {
  const { data = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectPlatformAdmin,
  })
  return data
}

function NotificationActions({
  notification,
  onNavigate,
}: {
  notification: KilnNotification
  onNavigate?: () => void
}) {
  const queryClient = useQueryClient()
  const routerNavigate = useNavigate()
  const platformAdmin = usePlatformAdmin()
  const { content } = notification
  const commands = notificationCommands(
    {
      navigate: (href) => {
        onNavigate?.()
        void routerNavigate({ href })
      },
      platformAdmin,
      queryClient,
    },
    notification
  )
  const { isPending, mutate, variables } = useMutation({
    mutationFn: async (command: NotificationCommand) => {
      markOpened(queryClient, notification)
      return command.run()
    },
    onError: showNotificationFailure("do that"),
  })
  const reportedResources =
    content.kind === "security.report" && !commands.length
      ? content.resources
      : null
  const movedServer =
    content.kind === "server.migration" &&
    content.outcome === "completed" &&
    content.mode === "migrate" &&
    !content.sourceDeleted &&
    !content.sourceDeleting
      ? content.source
      : null
  if (!commands.length && !reportedResources) return null
  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      {movedServer ? <DeleteMovedServerButton server={movedServer} /> : null}
      {reportedResources ? (
        <OpenResourceMenu
          resources={reportedResources}
          onNavigate={() => {
            markOpened(queryClient, notification)
            onNavigate?.()
          }}
        />
      ) : null}
      {commands.map((command) => (
        <Button
          key={command.key}
          variant={
            command.primary && commands.length > 1 ? "default" : "outline"
          }
          size="xs"
          disabled={isPending}
          onClick={() => mutate(command)}
        >
          {isPending && variables.key === command.key
            ? (command.pendingLabel ?? command.label)
            : command.label}
        </Button>
      ))}
    </div>
  )
}

// A finished move leaves the old server stopped where it was; deleting it
// is up to the person, and permanent, as the dialog says.
function DeleteMovedServerButton({ server }: { server: NotificationResource }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="destructive" size="xs" onClick={() => setOpen(true)}>
        Delete old server
      </Button>
      {open ? (
        <ServerDeleteDialog
          open
          target={{
            backupAvailable: true,
            id: server.id,
            name: server.name,
            relayId: server.relayId,
          }}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

// Each resource a report names, for people the Security page isn't open to.
function OpenResourceMenu({
  onNavigate,
  resources,
}: {
  onNavigate?: () => void
  resources: ReadonlyArray<NotificationResource>
}) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" className="relative shrink-0">
          Open
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {resources.map((resource) => (
          <DropdownMenuItem
            key={`${resource.type}:${resource.relayId}:${resource.id}`}
            onSelect={() => {
              onNavigate?.()
              void navigate({ href: notificationResourceHref(resource) })
            }}
          >
            {resource.name}
            <span className="ml-auto pl-3 text-xs text-muted-foreground">
              {resourceTypeLabels[resource.type]}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function selectPlatformAdmin(capabilities: { isPlatformAdmin: boolean }) {
  return capabilities.isPlatformAdmin
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
  "security.report": ShieldAlert,
  "server.migration": ArrowRightLeft,
} satisfies Record<
  NotificationContent["kind"],
  React.ComponentType<{ className?: string }>
>
