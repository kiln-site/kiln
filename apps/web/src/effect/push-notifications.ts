import { createHash } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import webpush from "web-push"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"

import appIcon192 from "@/assets/branding/app-icon-192.png?no-inline"
import { Database } from "@/effect/database"
import { CredentialError, ExternalServiceError } from "@/effect/errors"
import { decodeNotificationContent } from "@/effect/notifications"
import { databaseTable } from "@/lib/database-config"
import { developmentBypassUserId } from "@/lib/development-bypass"
import {
  betterAuthSecrets,
  developmentBypassEnabled,
  kilnPublicUrl,
} from "@/lib/environment"
import { notificationDetail, notificationTitle } from "@/lib/notification-text"
import { isPushServiceEndpoint } from "@/lib/push-endpoint"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export interface PushSubscriptionInput {
  endpoint: string
  keys: { auth: string; p256dh: string }
}

/** What the service worker shows. `tag` replaces an earlier one with it. */
export interface PushMessage {
  badge: string
  body?: string
  icon: string
  tag: string
  title: string
  url: string
}

export interface VapidKeys {
  privateKey: string
  publicKey: string
}

/**
 * Sends one push message. "gone" means the push service no longer knows the
 * subscription, as after the user turned notifications off in the browser.
 */
export class WebPush extends Context.Service<
  WebPush,
  {
    readonly send: (
      subscription: PushSubscriptionInput,
      message: PushMessage,
      vapid: VapidKeys
    ) => Effect.Effect<"delivered" | "gone", ExternalServiceError>
  }
>()("kiln/WebPush") {
  static readonly layer = Layer.succeed(
    WebPush,
    WebPush.of({
      send: (subscription, message, vapid) =>
        Effect.tryPromise({
          try: () =>
            webpush.sendNotification(subscription, JSON.stringify(message), {
              TTL: 24 * 60 * 60,
              timeout: 10_000,
              vapidDetails: { subject: vapidSubject(), ...vapid },
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.as("delivered" as const),
          Effect.catch((cause) =>
            cause instanceof webpush.WebPushError &&
            (cause.statusCode === 404 || cause.statusCode === 410)
              ? Effect.succeed("gone" as const)
              : Effect.fail(
                  ExternalServiceError.make({
                    cause,
                    message:
                      cause instanceof webpush.WebPushError
                        ? `Push service answered ${cause.statusCode}`
                        : "Push service could not be reached",
                    service: "web-push",
                  })
                )
          )
        ),
    })
  )
}

// Push services want a way to reach whoever sends; Apple refuses localhost.
function vapidSubject() {
  const url = kilnPublicUrl()
  return url.protocol === "https:" && url.hostname !== "localhost"
    ? url.origin
    : "mailto:push@kiln.site"
}

const vapidSettingId = "6f1c8e0a-3b9d-4c52-9a77-2e5d1f0b8c41"
const vapidSettingKey = "push.vapid"
const VAPID_PRIVATE_KEY_PURPOSE = "kiln-web-push-vapid-private-key"

const StoredVapidKeys = Schema.Struct({
  privateKeyCiphertext: Schema.String,
  publicKey: Schema.String,
})
const decodeStoredVapidKeys = Schema.decodeUnknownOption(StoredVapidKeys)
const decodeStoredVapidKeysJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredVapidKeys)
)

let vapidKeys: VapidKeys | undefined

/**
 * This installation's VAPID keys, made on first use. Every subscription is
 * bound to the public key, so they are kept for good; the private key is
 * stored encrypted with Hearth's secrets.
 */
export const vapidKeysEffect = Effect.fnUntraced(function* () {
  if (vapidKeys) return vapidKeys
  const database = yield* Database
  const load = database
    .queryRows<RowDataPacket & { setting_value: unknown }>(
      "notifications.push.loadVapidKeys",
      `SELECT setting_value FROM ${databaseTable("setting")}
        WHERE id = ? AND user_id IS NULL AND setting_key = ?
        LIMIT 1`,
      [vapidSettingId, vapidSettingKey]
    )
    .pipe(
      Effect.map(([row]) =>
        row === undefined
          ? Option.none()
          : typeof row.setting_value === "string"
            ? decodeStoredVapidKeysJson(row.setting_value)
            : decodeStoredVapidKeys(row.setting_value)
      )
    )
  let stored = yield* load
  if (Option.isNone(stored)) {
    const created = webpush.generateVAPIDKeys()
    const privateKeyCiphertext = yield* Effect.try({
      try: () =>
        encryptWithKeyring(
          created.privateKey,
          betterAuthSecrets(),
          VAPID_PRIVATE_KEY_PURPOSE
        ),
      catch: (cause) =>
        CredentialError.make({ cause, operation: "encrypt_vapid_key" }),
    })
    const now = yield* Clock.currentTimeMillis
    // Another Hearth may have made keys meanwhile; the first ones stay.
    yield* database.execute(
      "notifications.push.saveVapidKeys",
      `INSERT INTO ${databaseTable("setting")}
         (id, user_id, setting_key, setting_value, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        vapidSettingId,
        vapidSettingKey,
        JSON.stringify({ privateKeyCiphertext, publicKey: created.publicKey }),
        new Date(now),
        new Date(now),
      ]
    )
    stored = yield* load
  }
  if (Option.isNone(stored)) {
    return yield* CredentialError.make({
      cause: new Error("Stored VAPID keys are malformed"),
      operation: "load_vapid_key",
    })
  }
  const { privateKeyCiphertext, publicKey } = stored.value
  const decrypted = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        privateKeyCiphertext,
        betterAuthSecrets(),
        VAPID_PRIVATE_KEY_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({ cause, operation: "decrypt_vapid_key" }),
  })
  vapidKeys = { privateKey: decrypted.plaintext, publicKey }
  return vapidKeys
})

// One row per user and endpoint, so subscribing again from the same browser
// replaces the row.
function subscriptionId(userId: string, endpoint: string) {
  return createHash("sha256").update(`${userId}\n${endpoint}`).digest("hex")
}

// Enough for every browser a person uses; more only multiplies what each
// notification sends.
const maxSubscriptionsPerUser = 20

/**
 * Saves a device's subscription for the signed-in user, tied to the session
 * that turned push on.
 */
export const savePushSubscriptionEffect = Effect.fn(
  "notifications.push.subscribe"
)(function* (
  userId: string,
  sessionId: string,
  subscription: PushSubscriptionInput
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const table = databaseTable("push_subscription")
  yield* database.execute(
    "notifications.push.subscribe",
    `INSERT INTO ${table}
       (id, user_id, session_id, endpoint, p256dh, auth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE session_id = VALUES(session_id),
                             p256dh = VALUES(p256dh),
                             auth = VALUES(auth),
                             updated_at = VALUES(updated_at)`,
    [
      subscriptionId(userId, subscription.endpoint),
      userId,
      sessionId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      now,
      now,
    ]
  )
  yield* database.execute(
    "notifications.push.trimSubscriptions",
    `DELETE FROM ${table}
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM ${table}
           WHERE user_id = ?
           ORDER BY updated_at DESC
           LIMIT ${maxSubscriptionsPerUser}
        ) AS newest
      )`,
    [userId, userId]
  )
})

export const removePushSubscriptionEffect = Effect.fn(
  "notifications.push.unsubscribe"
)(function* (userId: string, endpoint: string) {
  const database = yield* Database
  yield* database.execute(
    "notifications.push.unsubscribe",
    `DELETE FROM ${databaseTable("push_subscription")} WHERE id = ?`,
    [subscriptionId(userId, endpoint)]
  )
})

/** Whether this browser's endpoint gets the session's user's pushes. */
export const pushSubscribedEffect = Effect.fn("notifications.push.state")(
  function* (userId: string, sessionId: string, endpoint: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "notifications.push.state",
      `SELECT 1 FROM ${databaseTable("push_subscription")}
        WHERE id = ? AND session_id = ?
        LIMIT 1`,
      [subscriptionId(userId, endpoint), sessionId]
    )
    return rows.length > 0
  }
)

interface SubscriptionRow extends RowDataPacket {
  auth: string
  endpoint: string
  id: string
  p256dh: string
  user_id: string
}

// The users' subscriptions whose sign-in is still active. The development
// sign-in has no session row.
const activeSubscriptionsEffect = Effect.fnUntraced(function* (
  userIds: ReadonlyArray<string>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const developmentSession = developmentBypassEnabled()
    ? `development:${developmentBypassUserId}`
    : null
  const rows = yield* database.queryRows<
    SubscriptionRow & { active: number | string }
  >(
    "notifications.push.subscriptions",
    `SELECT push.id, push.user_id, push.endpoint, push.p256dh, push.auth,
            (auth_session.id IS NOT NULL${
              developmentSession ? " OR push.session_id = ?" : ""
            }) AS active
       FROM ${databaseTable("push_subscription")} AS push
       LEFT JOIN ${databaseTable("session")} AS auth_session
         ON auth_session.id = push.session_id
        AND auth_session.userId = push.user_id
        AND auth_session.expiresAt > ?
      WHERE push.user_id IN (${userIds.map(() => "?").join(", ")})`,
    [
      ...(developmentSession ? [developmentSession] : []),
      new Date(now),
      ...userIds,
    ]
  )
  // Endpoints were checked when saved; checking again keeps a row written
  // any other way from aiming Hearth at another host.
  const usable = (row: (typeof rows)[number]) =>
    Number(row.active) === 1 && isPushServiceEndpoint(row.endpoint)
  return {
    active: rows.filter(usable),
    unusable: rows.filter((row) => !usable(row)),
  }
})

interface PendingNotificationRow extends RowDataPacket {
  created_at: number | string
  data: unknown
  dismissed_at: number | string | null
  id: string
  kind: string
  read_at: number | string | null
  user_id: string
}

// A notification older than this when Hearth gets to it, as after Hearth was
// down, stays in the inbox without buzzing anyone's phone.
const pushWindowMs = 60 * 60_000
const pushBatchSize = 200

/** Whether any notification is still waiting to be pushed. */
export const hasPendingPushesEffect = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket>(
    "notifications.push.pending",
    `SELECT 1 FROM ${databaseTable("notification")}
      WHERE pushed_at IS NULL
      LIMIT 1`
  )
  return rows.length > 0
})

/**
 * Pushes notifications that haven't been pushed to their users' signed-in
 * devices, each once even with several Hearths. Ones already read, cleared,
 * or too old are marked without sending. Subscriptions the push service no
 * longer knows, or whose sign-in ended, are deleted.
 */
export const pushPendingNotificationsEffect = Effect.fn("notifications.push")(
  function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const table = databaseTable("notification")
    const claimed = yield* database.transaction(
      "notifications.push.claim",
      (tx) =>
        Effect.gen(function* () {
          const rows = yield* tx.queryRows<PendingNotificationRow>(
            `SELECT id, user_id, kind, data, created_at, read_at, dismissed_at
               FROM ${table}
              WHERE pushed_at IS NULL
              ORDER BY created_at
              LIMIT ${pushBatchSize}
              FOR UPDATE SKIP LOCKED`
          )
          if (rows.length)
            yield* tx.execute(
              `UPDATE ${table} SET pushed_at = ?
                WHERE id IN (${rows.map(() => "?").join(", ")})`,
              [now, ...rows.map((row) => row.id)]
            )
          return rows
        })
    )
    const pending = claimed.flatMap((row) => {
      if (
        row.read_at !== null ||
        row.dismissed_at !== null ||
        Number(row.created_at) < now - pushWindowMs
      )
        return []
      const content = decodeNotificationContent(row.kind, row.data)
      return Option.isSome(content)
        ? [
            {
              message: pushMessage({
                body: notificationDetail(content.value) ?? undefined,
                tag: row.id,
                title: notificationTitle(content.value),
                url: `/notifications?focus=${row.id}`,
              }),
              userId: row.user_id,
            },
          ]
        : []
    })
    if (!pending.length) return claimed.length

    const userIds = [...new Set(pending.map((entry) => entry.userId))]
    const { active, unusable } = yield* activeSubscriptionsEffect(userIds)
    const gone = unusable.map((row) => row.id)
    if (active.length) {
      const vapid = yield* vapidKeysEffect()
      const webPush = yield* WebPush
      const deliveries = pending.flatMap(({ message, userId }) =>
        active
          .filter((subscription) => subscription.user_id === userId)
          .map((subscription) => ({ message, subscription }))
      )
      yield* Effect.forEach(
        deliveries,
        ({ message, subscription }) =>
          webPush
            .send(
              {
                endpoint: subscription.endpoint,
                keys: { auth: subscription.auth, p256dh: subscription.p256dh },
              },
              message,
              vapid
            )
            .pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (result === "gone") gone.push(subscription.id)
                })
              ),
              // One unreachable device doesn't hold back the others; the
              // notification is still in the inbox.
              Effect.catch((error) =>
                Effect.logWarning("Push notification not delivered", error)
              )
            ),
        { concurrency: 8, discard: true }
      )
    }
    if (gone.length)
      yield* database.execute(
        "notifications.push.removeGone",
        `DELETE FROM ${databaseTable("push_subscription")}
          WHERE id IN (${gone.map(() => "?").join(", ")})`,
        gone
      )
    return claimed.length
  }
)

// The badge is Android's status bar icon. It lives in `public`, since only
// the server names it and the browser fetches it.
function pushMessage(
  message: Omit<PushMessage, "badge" | "icon">
): PushMessage {
  return { ...message, badge: "/notification-badge.png", icon: appIcon192 }
}

/**
 * Sends the device a confirmation, so turning push on shows right away
 * whether it works. A subscription the push service refuses is removed.
 */
export const sendPushConfirmationEffect = Effect.fn(
  "notifications.push.confirm"
)(function* (userId: string, subscription: PushSubscriptionInput) {
  if (!isPushServiceEndpoint(subscription.endpoint)) return
  const vapid = yield* vapidKeysEffect()
  const webPush = yield* WebPush
  const result = yield* webPush
    .send(
      subscription,
      pushMessage({
        body: "Kiln will notify this device about invitations, updates, and warnings.",
        tag: "push-enabled",
        title: "Push notifications are on",
        url: "/notifications",
      }),
      vapid
    )
    .pipe(
      Effect.tapError(() =>
        removePushSubscriptionEffect(userId, subscription.endpoint)
      )
    )
  if (result === "gone") {
    yield* removePushSubscriptionEffect(userId, subscription.endpoint)
    return yield* ExternalServiceError.make({
      message: "The push service no longer knows this device",
      service: "web-push",
    })
  }
})
