import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import { z } from "zod"

import {
  WebPush,
  pushSubscribedEffect,
  removePushSubscriptionEffect,
  savePushSubscriptionEffect,
  sendPushConfirmationEffect,
  vapidKeysEffect,
} from "@/effect/push-notifications"
import { runAppEffect } from "@/effect/runtime"
import { isPushServiceEndpoint } from "@/lib/push-endpoint"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceIdentity } from "@/server/auth"

// Subscriptions are keyed by the signed-in user and session, never by input.

const endpointSchema = z
  .string()
  .max(2048)
  .refine(isPushServiceEndpoint, "Not a browser push service")
// Browsers send the keys as unpadded base64url.
const keySchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/)

/**
 * The public key browsers subscribe with, and whether this browser's
 * `endpoint` already gets the signed-in user's notifications.
 */
export const getPushNotificationState = createServerFn({ method: "GET" })
  .validator(z.strictObject({ endpoint: endpointSchema.nullable() }))
  .handler(async ({ data }) => {
    const { sessionId, user } = await requireEligibleResourceIdentity()
    return runAppEffect(
      "notifications.push.state",
      Effect.gen(function* () {
        const { publicKey } = yield* vapidKeysEffect()
        const subscribed = data.endpoint
          ? yield* pushSubscribedEffect(user.id, sessionId, data.endpoint)
          : false
        return { publicKey, subscribed }
      })
    )
  })

const subscriptionSchema = z.strictObject({
  endpoint: endpointSchema,
  keys: z.strictObject({ auth: keySchema, p256dh: keySchema }),
})

// A browser's subscription is the person's own, one row by its endpoint, so
// subscribing and unsubscribing hold nothing; neither is audited.
const subscribe = operation<{
  readonly sessionId: string
  readonly subscription: z.infer<typeof subscriptionSchema>
}>()({
  name: "notifications.push.subscribe",
  doing: "Sending this browser your notifications",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: user, input: { sessionId, subscription } }) =>
    savePushSubscriptionEffect(user.id, sessionId, subscription).pipe(
      Effect.andThen(sendPushConfirmationEffect(user.id, subscription)),
      Effect.provide(WebPush.layer)
    ),
})

/** Sends this browser the signed-in user's notifications. */
export const subscribePushNotifications = createServerFn({ method: "POST" })
  .validator(subscriptionSchema)
  .handler(async ({ data }) => {
    const { sessionId, user } = await requireEligibleResourceIdentity()
    await runOperationPromise(
      subscribe,
      { sessionId, subscription: data },
      { user }
    )
  })

const unsubscribe = operation<{ readonly endpoint: string }>()({
  name: "notifications.push.unsubscribe",
  doing: "Stopping this browser's notifications",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: user, input }) =>
    removePushSubscriptionEffect(user.id, input.endpoint),
})

export const unsubscribePushNotifications = createServerFn({ method: "POST" })
  .validator(z.strictObject({ endpoint: endpointSchema }))
  .handler(async ({ data }) => {
    const { user } = await requireEligibleResourceIdentity()
    await runOperationPromise(unsubscribe, data, { user })
  })
