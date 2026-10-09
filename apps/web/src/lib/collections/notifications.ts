import { collectionOptions } from "@tanstack/react-db"
import {
  MutationObserver,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { forkPromise } from "@/effect/promise"
import type { InvitationOutcome, KilnNotification } from "@/lib/notifications"
import { queryKeys } from "@/lib/query-options"
import {
  clearNotifications,
  dismissNotification,
  getNotifications,
  markNotificationsRead,
} from "@/server/notifications"

// The user's whole (capped) inbox. The bell, popover, and notifications page
// are live queries over it; realtime invalidates the key when it changes.
export function notificationsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.notifications,
    queryFn: () => getNotifications(),
    staleTime: Infinity,
  })
}

export const notificationsCollectionOptions = collectionOptions(
  "hearth-notifications",
  (client) =>
    queryCollectionOptions({
      id: "hearth-notifications",
      getKey: (notification) => notification.id,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getNotifications(),
      queryKey: queryKeys.notifications,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    })
)

type NotificationsChange = (
  notifications: Array<KilnNotification>
) => Array<KilnNotification>

// Changes the cached inbox at once, then reconciles with the server. A failed
// change puts the inbox back.
function notificationsMutationOptions<TInput>(
  queryClient: QueryClient,
  action: string,
  mutationFn: (input: TInput) => Promise<unknown>,
  change: (input: TInput) => NotificationsChange,
  onFailure?: (error: Error) => void
) {
  const { queryKey } = notificationsQueryOptions()
  return mutationOptions({
    mutationKey: ["notifications", action] as const,
    mutationFn,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)
      if (previous) queryClient.setQueryData(queryKey, change(input)(previous))
      return { previous }
    },
    onError: (error, _input, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKey, context.previous)
      onFailure?.(error)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
}

export function markNotificationsReadMutationOptions(queryClient: QueryClient) {
  return notificationsMutationOptions(
    queryClient,
    "mark-read",
    (ids: Array<string>) => markNotificationsRead({ data: { ids } }),
    (ids) => {
      const marked = new Set(ids)
      const readAt = Date.now()
      return (notifications) =>
        notifications.map((notification) =>
          marked.has(notification.id) && notification.readAt === null
            ? { ...notification, readAt }
            : notification
        )
    }
  )
}

export function dismissNotificationMutationOptions(
  queryClient: QueryClient,
  onFailure: (error: Error) => void
) {
  return notificationsMutationOptions(
    queryClient,
    "dismiss",
    (id: string) => dismissNotification({ data: { id } }),
    (id) => (notifications) =>
      notifications.filter((notification) => notification.id !== id),
    onFailure
  )
}

/** Clears everything created at or before `through`, the newest one seen. */
export function clearNotificationsMutationOptions(
  queryClient: QueryClient,
  onFailure: (error: Error) => void
) {
  return notificationsMutationOptions(
    queryClient,
    "clear",
    (through: number) => clearNotifications({ data: { through } }),
    (through) => (notifications) =>
      notifications.filter((notification) => notification.createdAt > through),
    onFailure
  )
}

/**
 * Shows an invitation's answer on its notification right away; a declined one
 * is cleared. The server records the same outcome and the realtime refresh
 * confirms it.
 */
export function setCachedInvitationOutcome(
  queryClient: QueryClient,
  id: string,
  outcome: InvitationOutcome
) {
  const readAt = Date.now()
  queryClient.setQueryData(
    notificationsQueryOptions().queryKey,
    (notifications) =>
      notifications?.flatMap((notification) =>
        notification.id !== id || notification.content.kind !== "access.invited"
          ? [notification]
          : outcome === "declined"
            ? []
            : [
                {
                  ...notification,
                  content: { ...notification.content, outcome },
                  readAt: notification.readAt ?? readAt,
                },
              ]
      )
  )
}

/** How many of the newest notifications the popover lists. */
export const notificationsPopoverLimit = 10

/**
 * Marks the unread notifications among the popover's newest rows read, for
 * opening the popover from an event handler. Older unread ones stay unread
 * until the user sees them. Returns the IDs it marked so the view can keep
 * them highlighted.
 */
export function markCachedNotificationsRead(
  queryClient: QueryClient
): ReadonlySet<string> {
  const shown = [
    ...(queryClient.getQueryData(notificationsQueryOptions().queryKey) ?? []),
  ]
    .sort(newestFirst)
    .slice(0, notificationsPopoverLimit)
  const unread = shown.flatMap((notification) =>
    notification.readAt === null ? [notification.id] : []
  )
  if (unread.length) {
    const observer = new MutationObserver(
      queryClient,
      markNotificationsReadMutationOptions(queryClient)
    )
    // A failure only rolls the read marks back; nothing to tell the user.
    forkPromise(() => observer.mutate(unread))
  }
  return new Set(unread)
}

// The popover's order: newest first, then by ID, as the server sorts them.
function newestFirst(left: KilnNotification, right: KilnNotification) {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}
