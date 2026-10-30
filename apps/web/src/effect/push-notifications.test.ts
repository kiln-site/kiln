import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { notifyUsersEffect } from "@/effect/notifications"
import {
  WebPush,
  pushPendingNotificationsEffect,
  savePushSubscriptionEffect,
  vapidKeysEffect,
} from "@/effect/push-notifications"
import { databaseTableName } from "@/lib/database-config"
import type { NotificationContent } from "@/lib/notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

const firstSecret = `1:${"s".repeat(32)}`
const secondSecret = `2:${"t".repeat(32)}`
vi.stubEnv("BETTER_AUTH_SECRETS", firstSecret)

// A verified account that may read its inbox.
const insertMember = (id: string, row: Record<string, string | Date> = {}) =>
  insertUser(id, { emailVerifiedAt: new Date(0), ...row })

const removed: NotificationContent = {
  actorName: "Owner",
  kind: "access.removed",
  resource: {
    id: "inst-a",
    name: "Survival",
    relayId: "relay-a",
    type: "instance",
  },
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

// The push service, recording what it was asked to deliver.
function fakePushService() {
  const sent: Array<{ endpoint: string; title: string }> = []
  const layer = Layer.succeed(
    WebPush,
    WebPush.of({
      send: (target, message) =>
        Effect.sync(() => {
          sent.push({ endpoint: target.endpoint, title: message.title })
          return "delivered" as const
        }),
    })
  )
  return { layer, sent }
}

// A push waits this long for an open tab to show it first.
const pushDelay = TestClock.adjust("5 seconds")

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
          yield* insertMember("user-a")
          yield* insertMember("user-b")
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
          yield* pushDelay
          yield* pushPendingNotificationsEffect().pipe(
            Effect.provide(push.layer)
          )
          // Another pass, as by a second Hearth, finds nothing left.
          yield* pushPendingNotificationsEffect().pipe(
            Effect.provide(push.layer)
          )

          assert.deepStrictEqual(
            push.sent.map(({ endpoint }) => endpoint),
            [subscription("phone").endpoint]
          )
          // Devices whose sign-in ended stop getting pushes for good.
          assert.deepStrictEqual(yield* subscriptionEndpoints, [
            subscription("phone").endpoint,
          ])
        })
    )

    it.effect("pushes nothing to an account that was disabled", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertMember("user-a")
        yield* TestClock.setTime(1_000_000)
        yield* insertSession("session-a", "user-a", 2_000_000)
        yield* savePushSubscriptionEffect(
          "user-a",
          "session-a",
          subscription("phone")
        )
        const push = fakePushService()

        yield* notifyUsersEffect(["user-a"], "removed:1", removed)
        yield* pushDelay
        // Disabling an account leaves its sessions in place.
        yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) =>
              sql`UPDATE ${sql(databaseTableName("user"))} SET status = 'disabled' WHERE id = 'user-a'`
          )
        )
        yield* pushPendingNotificationsEffect().pipe(Effect.provide(push.layer))

        assert.deepStrictEqual(push.sent, [])
        // The device is kept for when the account is enabled again.
        assert.deepStrictEqual(yield* subscriptionEndpoints, [
          subscription("phone").endpoint,
        ])
      })
    )

    it.effect("keeps its keys when Hearth's secret is replaced", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        vi.stubEnv("BETTER_AUTH_SECRETS", firstSecret)
        const created = yield* vapidKeysEffect()

        // A new secret is added, then the old one retired.
        vi.stubEnv("BETTER_AUTH_SECRETS", `${secondSecret},${firstSecret}`)
        yield* vapidKeysEffect()
        vi.stubEnv("BETTER_AUTH_SECRETS", secondSecret)
        const afterRotation = yield* vapidKeysEffect()

        assert.deepStrictEqual(afterRotation, created)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => vi.stubEnv("BETTER_AUTH_SECRETS", firstSecret))
        )
      )
    )
  })
})
