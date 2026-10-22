import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { notifyUsersEffect } from "@/effect/notifications"
import {
  WebPush,
  pushPendingNotificationsEffect,
  savePushSubscriptionEffect,
} from "@/effect/push-notifications"
import type { NotificationContent } from "@/lib/notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const removed: NotificationContent = {
  actorName: "Owner",
  kind: "access.removed",
  resource: { id: "inst-a", name: "Survival", relayId: "relay-a", type: "instance" },
}

const subscription = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { auth: "auth", p256dh: "p256dh" },
})

const insertSession = (id: string, userId: string, expiresAt: number) =>
  insertRows("session", {
    id,
    expiresAt: new Date(expiresAt),
    token: `token-${id}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userId,
  })

// The push service, answering "gone" for the endpoints in `gone`.
function fakePushService(gone: ReadonlySet<string> = new Set()) {
  const sent: Array<{ endpoint: string; title: string }> = []
  const layer = Layer.succeed(
    WebPush,
    WebPush.of({
      send: (target, message) =>
        Effect.sync(() => {
          sent.push({ endpoint: target.endpoint, title: message.title })
          return gone.has(target.endpoint) ? "gone" : "delivered"
        }),
    })
  )
  return { layer, sent }
}

const subscriptionEndpoints = Effect.map(
  selectRows<{ endpoint: string }>("push_subscription"),
  (rows) => rows.map((row) => row.endpoint).sort()
)

describeMysql("push notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "pushes each new notification once, only to signed-in devices",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")
          yield* insertUser("user-b")
          yield* TestClock.setTime(1_000_000)
          yield* insertSession("session-a", "user-a", 2_000_000)
          yield* insertSession("expired-a", "user-a", 500_000)
          yield* savePushSubscriptionEffect(
            "user-a",
            "session-a",
            subscription("phone")
          )
          yield* savePushSubscriptionEffect(
            "user-a",
            "expired-a",
            subscription("old-laptop")
          )
          yield* savePushSubscriptionEffect(
            "user-a",
            "signed-out",
            subscription("tablet")
          )
          const push = fakePushService()

          yield* notifyUsersEffect(["user-a", "user-b"], "removed:1", removed)
          yield* pushPendingNotificationsEffect().pipe(
            Effect.provide(push.layer)
          )
          // Another pass, as by a second Hearth, finds nothing left.
          yield* pushPendingNotificationsEffect().pipe(
            Effect.provide(push.layer)
          )

          assert.deepStrictEqual(push.sent, [
            {
              endpoint: subscription("phone").endpoint,
              title: "Removed from Survival",
            },
          ])
          // Devices whose sign-in ended stop getting pushes for good.
          assert.deepStrictEqual(yield* subscriptionEndpoints, [
            subscription("phone").endpoint,
          ])
        })
    )

    it.effect(
      "skips notifications already read or too old, and forgets gone devices",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")
          yield* TestClock.setTime(10_000_000)
          yield* insertSession("session-a", "user-a", 20_000_000)
          for (const name of ["phone", "uninstalled"])
            yield* savePushSubscriptionEffect(
              "user-a",
              "session-a",
              subscription(name)
            )
          const push = fakePushService(
            new Set([subscription("uninstalled").endpoint])
          )

          yield* notifyUsersEffect(["user-a"], "removed:old", removed)
          yield* TestClock.adjust("2 hours")
          yield* insertRows("notification", {
            id: "00000000-0000-4000-8000-000000000001",
            user_id: "user-a",
            kind: "access.removed",
            source_key: "removed:already-read",
            data: JSON.stringify({ ...removed, kind: undefined }),
            created_at: 10_000_000 + 7_200_000,
            read_at: 10_000_000 + 7_200_000,
          })
          yield* notifyUsersEffect(["user-a"], "removed:new", removed)
          yield* pushPendingNotificationsEffect().pipe(
            Effect.provide(push.layer)
          )

          // Only the one new unread notification, to both devices.
          assert.strictEqual(push.sent.length, 2)
          assert.deepStrictEqual(yield* subscriptionEndpoints, [
            subscription("phone").endpoint,
          ])
        })
    )
  })
})
