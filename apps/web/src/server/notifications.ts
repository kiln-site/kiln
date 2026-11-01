import { createServerFn } from "@tanstack/react-start"
import type { Effect } from "effect"
import { z } from "zod"

import {
  loadUserNotificationPreferencesEffect,
  saveNotificationPreferencesEffect,
} from "@/effect/notification-preferences"
import {
  acknowledgeNotificationsSeenEffect,
  clearNotificationsEffect,
  dismissNotificationEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { runAppEffect } from "@/effect/runtime"
import { notificationPreferencesUpdateSchema } from "@/lib/notification-preferences"
import { notificationHistoryLimit } from "@/lib/notifications"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { exclusive, partKey, type LaneLock } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"

// Notifications are addressed to one user, so every read and write is keyed
// by the signed-in user's ID and never by input.

/**
 * A change to the signed-in person's own notifications, as an operation.
 * Each is one statement on rows only they have, so it holds nothing unless
 * it says; none is audited.
 */
const ownNotifications = <Input, A, E, R>(definition: {
  readonly name: string
  readonly doing: string
  readonly locks?: (user: AuthenticatedUser) => ReadonlyArray<LaneLock>
  readonly run: (
    user: AuthenticatedUser,
    input: Input
  ) => Effect.Effect<A, E, R>
}) =>
  operation<Input>()({
    name: definition.name,
    doing: definition.doing,
    authorize: ({ user }) => signedIn(user),
    locks: ({ context: user }) => definition.locks?.(user) ?? [],
    run: ({ context: user, input }) => definition.run(user, input),
  })

export const getNotifications = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    return runAppEffect("notifications.list", listNotificationsEffect(user.id))
  }
)

const markRead = ownNotifications({
  name: "notifications.markRead",
  doing: "Marking your notifications read",
  run: (user, input: { readonly ids?: ReadonlyArray<string> | undefined }) =>
    markNotificationsReadEffect(user.id, input.ids ?? "all"),
})

/** Marks the given notifications read, or every unread one without `ids`. */
export const markNotificationsRead = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      ids: z.array(z.uuid()).min(1).max(notificationHistoryLimit).optional(),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const marked = await runOperationPromise(markRead, data, { user })
    if (marked.length) publishNotificationChange([user.id])
    return marked
  })

const dismiss = ownNotifications({
  name: "notifications.dismiss",
  doing: "Dismissing your notification",
  run: (user, input: { readonly id: string }) =>
    dismissNotificationEffect(user.id, input.id),
})

export const dismissNotification = createServerFn({ method: "POST" })
  .validator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const dismissed = await runOperationPromise(dismiss, data, { user })
    if (dismissed > 0) publishNotificationChange([user.id])
  })

const clear = ownNotifications({
  name: "notifications.clear",
  doing: "Clearing your notifications",
  run: (user, input: { readonly through: number }) =>
    clearNotificationsEffect(user.id, input.through),
})

/** Clears everything created at or before `through`, the newest one seen. */
export const clearNotifications = createServerFn({ method: "POST" })
  .validator(z.strictObject({ through: z.number().int().nonnegative() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const cleared = await runOperationPromise(clear, data, { user })
    if (cleared > 0) publishNotificationChange([user.id])
  })

const acknowledgeSeen = ownNotifications({
  name: "notifications.acknowledgeSeen",
  doing: "Marking your notifications seen",
  run: (user, input: { readonly ids: ReadonlyArray<string> }) =>
    acknowledgeNotificationsSeenEffect(user.id, input.ids),
})

/**
 * Says a tab the user is using showed these notifications, so they aren't
 * pushed to the user's devices too.
 */
export const acknowledgeNotificationsSeen = createServerFn({ method: "POST" })
  .validator(z.strictObject({ ids: z.array(z.uuid()).min(1).max(50) }))
  .handler(async ({ data }) => {
    await runOperationPromise(acknowledgeSeen, data, {
      user: await requireEligibleResourceUser(),
    })
  })

export const getNotificationPreferences = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireEligibleResourceUser()
  return runAppEffect(
    "notificationPreferences.load",
    loadUserNotificationPreferencesEffect(user.id)
  )
})

// Saving merges the choices into what's stored, so one save goes after
// another rather than one losing the other's choices.
const savePreferences = ownNotifications({
  name: "notificationPreferences.save",
  doing: "Saving your notification settings",
  locks: (user) => [
    exclusive(partKey(`user-settings:${user.id}`, "notifications")),
  ],
  run: (user, input: z.infer<typeof notificationPreferencesUpdateSchema>) =>
    saveNotificationPreferencesEffect(user.id, input),
})

/** Saves the given choices, keeping the rest; answers all of them. */
export const saveNotificationPreferences = createServerFn({ method: "POST" })
  .validator(notificationPreferencesUpdateSchema)
  .handler(async ({ data }) =>
    runOperationPromise(savePreferences, data, {
      user: await requireEligibleResourceUser(),
    })
  )
