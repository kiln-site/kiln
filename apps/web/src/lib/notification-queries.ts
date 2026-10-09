import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query"
import type { InfiniteData, QueryClient } from "@tanstack/react-query"

import type {
  KilnNotification,
  NotificationCursor,
  NotificationInbox,
  NotificationPage,
} from "@/lib/notifications"
import { queryKeys } from "@/lib/query-options"
import {
  clearNotifications,
  dismissNotification,
  getNotificationInbox,
  getNotificationsPage,
  markNotificationsRead,
} from "@/server/notifications"

export function notificationInboxQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.notifications.inbox,
    queryFn: () => getNotificationInbox(),
    staleTime: Infinity,
  })
}

export function selectUnreadNotificationCount(inbox: NotificationInbox) {
  return inbox.unreadCount
}

export function notificationsPageQueryOptions() {
  return infiniteQueryOptions({
    queryKey: queryKeys.notifications.page,
    queryFn: ({ pageParam }) =>
      getNotificationsPage({ data: { before: pageParam } }),
    initialPageParam: null as NotificationCursor | null,
    getNextPageParam: (page: NotificationPage) => page.nextCursor,
    staleTime: Infinity,
  })
}

type NotificationUpdate = (
  notification: KilnNotification
) => KilnNotification | null

interface NotificationCacheSnapshot {
  inbox: NotificationInbox | undefined
  page: InfiniteData<NotificationPage, unknown> | undefined
}

// Applies one change to the sidebar inbox and the notifications page alike.
// `unreadCount` reads the inbox before the change and returns the new total.
async function updateNotificationCaches(
  queryClient: QueryClient,
  update: NotificationUpdate,
  unreadCount: (inbox: NotificationInbox) => number
): Promise<NotificationCacheSnapshot> {
  const inboxKey = notificationInboxQueryOptions().queryKey
  const pageKey = notificationsPageQueryOptions().queryKey
  await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all })
  const snapshot = {
    inbox: queryClient.getQueryData(inboxKey),
    page: queryClient.getQueryData(pageKey),
  }
  const apply = (notifications: ReadonlyArray<KilnNotification>) =>
    notifications.flatMap((notification) => {
      const next = update(notification)
      return next ? [next] : []
    })
  queryClient.setQueryData(inboxKey, (inbox) =>
    inbox
      ? {
          notifications: apply(inbox.notifications),
          unreadCount: unreadCount(inbox),
        }
      : inbox
  )
  queryClient.setQueryData(pageKey, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            notifications: apply(page.notifications),
          })),
        }
      : data
  )
  return snapshot
}

function restoreNotificationCaches(
  queryClient: QueryClient,
  snapshot: NotificationCacheSnapshot | undefined
) {
  if (!snapshot) return
  queryClient.setQueryData(
    notificationInboxQueryOptions().queryKey,
    snapshot.inbox
  )
  queryClient.setQueryData(
    notificationsPageQueryOptions().queryKey,
    snapshot.page
  )
}

// Reading or clearing "through" a time covers every older row on the server,
// so only newer unread rows still count.
function unreadAfter(through: number) {
  return (inbox: NotificationInbox) =>
    inbox.notifications.filter(
      (notification) =>
        notification.readAt === null && notification.createdAt > through
    ).length
}

/** Marks everything created at or before `through` as read. */
export function markNotificationsReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["notifications", "mark-read"] as const,
    mutationFn: (through: number) =>
      markNotificationsRead({ data: { through } }),
    onMutate: (through) => {
      const readAt = Date.now()
      return updateNotificationCaches(
        queryClient,
        (notification) =>
          notification.readAt === null && notification.createdAt <= through
            ? { ...notification, readAt }
            : notification,
        unreadAfter(through)
      )
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  })
}

export function dismissNotificationMutationOptions(
  queryClient: QueryClient,
  onFailure: (error: Error) => void
) {
  return mutationOptions({
    mutationKey: ["notifications", "dismiss"] as const,
    mutationFn: (id: string) => dismissNotification({ data: { id } }),
    onMutate: (id) =>
      updateNotificationCaches(
        queryClient,
        (notification) => (notification.id === id ? null : notification),
        (inbox) =>
          inbox.unreadCount -
          (inbox.notifications.some(
            (notification) =>
              notification.id === id && notification.readAt === null
          )
            ? 1
            : 0)
      ),
    onError: (error, _id, snapshot) => {
      restoreNotificationCaches(queryClient, snapshot)
      onFailure(error)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  })
}

/** Clears every notification created at or before `through`. */
export function clearNotificationsMutationOptions(
  queryClient: QueryClient,
  onFailure: (error: Error) => void
) {
  return mutationOptions({
    mutationKey: ["notifications", "clear"] as const,
    mutationFn: (through: number) => clearNotifications({ data: { through } }),
    onMutate: (through) =>
      updateNotificationCaches(
        queryClient,
        (notification) =>
          notification.createdAt <= through ? null : notification,
        unreadAfter(through)
      ),
    onError: (error, _through, snapshot) => {
      restoreNotificationCaches(queryClient, snapshot)
      onFailure(error)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  })
}
