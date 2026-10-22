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

/** Sends this browser the signed-in user's notifications. */
export const subscribePushNotifications = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      endpoint: endpointSchema,
      keys: z.strictObject({ auth: keySchema, p256dh: keySchema }),
    })
  )
  .handler(async ({ data }) => {
    const { sessionId, user } = await requireEligibleResourceIdentity()
    await runAppEffect(
      "notifications.push.subscribe",
      savePushSubscriptionEffect(user.id, sessionId, data).pipe(
        Effect.andThen(sendPushConfirmationEffect(user.id, data)),
        Effect.provide(WebPush.layer)
      )
    )
  })

export const unsubscribePushNotifications = createServerFn({ method: "POST" })
  .validator(z.strictObject({ endpoint: endpointSchema }))
  .handler(async ({ data }) => {
    const { user } = await requireEligibleResourceIdentity()
    await runAppEffect(
      "notifications.push.unsubscribe",
      removePushSubscriptionEffect(user.id, data.endpoint)
    )
  })
