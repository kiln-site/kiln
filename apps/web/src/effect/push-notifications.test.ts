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
          yield* insertMember("user-a")
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
            push_pending: 1,
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
        // Disabling an account leaves its sessions in place.
        yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) =>
              sql`UPDATE ${sql(databaseTableName("user"))} SET status = 'disabled' WHERE id = 'user-a'`
          )
        )
        yield* pushPendingNotificationsEffect().pipe(
          Effect.provide(push.layer)
        )

        assert.deepStrictEqual(push.sent, [])
        // The device is kept for when the account is enabled again.
        assert.deepStrictEqual(yield* subscriptionEndpoints, [
          subscription("phone").endpoint,
        ])
      })
    )

    it.effect("pushes once when two Hearths pass at the same time", () =>
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

        for (const key of ["removed:1", "removed:2", "removed:3"])
          yield* notifyUsersEffect(["user-a"], key, removed)
        yield* Effect.all(
          [
            pushPendingNotificationsEffect(),
            pushPendingNotificationsEffect(),
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(push.layer))

        assert.strictEqual(push.sent.length, 3)
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
