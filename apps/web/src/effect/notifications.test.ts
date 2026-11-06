import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  clearNotificationsEffect,
  dismissNotificationEffect,
  forgetNotificationsEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  notifyUsersEffect,
  refreshDiskLimitUsageEffect,
  replaceNotificationEffect,
  sourceKeysEffect,
} from "@/effect/notifications"
import type { NotificationContent } from "@/lib/notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

const release: NotificationContent = {
  kind: "kiln.release",
  name: "v0.3.0",
  url: "https://github.com/example/kiln/releases/tag/v0.3.0",
  version: "0.3.0",
}

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

const deployed = (
  id: string,
  status: "failed" | "succeeded",
  appId = "app-a"
): Extract<NotificationContent, { kind: "app.deployed" }> => ({
  deploymentId: id,
  kind: "app.deployed",
  resource: { id: appId, name: appId, relayId: "relay-a", type: "app" },
  status,
  update: false,
})

const isApp = (appId: string) => (content: NotificationContent) =>
  content.kind === "app.deployed" && content.resource.id === appId

// One deployment, adding up the unread ones it replaces.
const deliverDeployment = (
  userId: string,
  id: string,
  status: "failed" | "succeeded",
  {
    actorUserId,
    appId = "app-a",
  }: { actorUserId?: string; appId?: string } = {}
) =>
  replaceNotificationEffect(
    userId,
    "app.deployed",
    (unread) => ({
      ...deployed(id, status, appId),
      count: unread.length + 1,
    }),
    {
      actorUserId,
      matches: isApp(appId),
      settles: (content) =>
        status === "succeeded" &&
        isApp(appId)(content) &&
        content.kind === "app.deployed" &&
        content.status === "failed",
      sourceKey: `app.deployed:${id}`,
    }
  )

const contents = (userId: string) =>
  Effect.map(listNotificationsEffect(userId), (notifications) =>
    notifications.map(({ content, readAt }) => ({
      content,
      read: readAt !== null,
    }))
  )

describeMysql("notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect("delivers each event once and keeps every inbox private", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* insertUser("user-b")

        yield* TestClock.setTime(1_000)
        yield* notifyUsersEffect(
          ["user-a", "user-b"],
          "kiln.release:0.3.0",
          release
        )
        // A retried or repeated announcement leaves the inbox unchanged.
        yield* notifyUsersEffect(["user-a", "user-a"], "kiln.release:0.3.0", {
          ...release,
          name: "renamed",
        })
        yield* TestClock.setTime(2_000)
        yield* notifyUsersEffect(
          ["user-a"],
          "access.removed:grant-a:2",
          removed
        )

        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: false },
          { content: release, read: false },
        ])
        assert.deepStrictEqual(yield* contents("user-b"), [
          { content: release, read: false },
        ])
      })
    )

    it.effect("merges one resource's notifications into one row", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")

        yield* TestClock.setTime(1_000)
        yield* deliverDeployment("user-a", "one", "succeeded")
        yield* TestClock.setTime(2_000)
        yield* deliverDeployment("user-a", "other", "succeeded", {
          appId: "app-b",
        })
        yield* TestClock.setTime(3_000)
        yield* deliverDeployment("user-a", "two", "succeeded")

        assert.deepStrictEqual(yield* contents("user-a"), [
          {
            content: { ...deployed("two", "succeeded"), count: 2 },
            read: false,
          },
          {
            content: {
              ...deployed("other", "succeeded", "app-b"),
              count: 1,
            },
            read: false,
          },
        ])
      })
    )

    it.effect("doesn't count a retried event twice", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")

        yield* TestClock.setTime(1_000)
        yield* deliverDeployment("user-a", "one", "succeeded")
        yield* TestClock.setTime(2_000)
        yield* deliverDeployment("user-a", "two", "succeeded")
        yield* TestClock.setTime(3_000)
        const changed = yield* deliverDeployment("user-a", "one", "succeeded")

        assert.isFalse(changed)
        assert.deepStrictEqual(yield* contents("user-a"), [
          {
            content: { ...deployed("two", "succeeded"), count: 2 },
            read: false,
          },
        ])
      })
    )

    it.effect("starts counting over once the user has read it", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")

        yield* TestClock.setTime(1_000)
        yield* deliverDeployment("user-a", "one", "succeeded")
        yield* markNotificationsReadEffect("user-a", "all")
        yield* TestClock.setTime(2_000)
        yield* deliverDeployment("user-a", "two", "succeeded")

        assert.deepStrictEqual(yield* contents("user-a"), [
          {
            content: { ...deployed("two", "succeeded"), count: 1 },
            read: false,
          },
        ])
      })
    )

    it.effect(
      "lets someone's own fix settle what it fixed, and nothing else",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")

          yield* TestClock.setTime(1_000)
          yield* deliverDeployment("user-a", "one", "failed")
          yield* deliverDeployment("user-a", "other", "succeeded", {
            appId: "app-b",
          })
          yield* TestClock.setTime(2_000)
          yield* deliverDeployment("user-a", "two", "succeeded", {
            actorUserId: "user-a",
          })
          yield* deliverDeployment("user-a", "three", "succeeded", {
            actorUserId: "user-a",
            appId: "app-b",
          })

          assert.deepStrictEqual(yield* contents("user-a"), [
            {
              content: {
                ...deployed("other", "succeeded", "app-b"),
                count: 1,
              },
              read: false,
            },
          ])
        })
    )

    it.effect("warns again when a condition it forgot comes back", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        const warning: NotificationContent = {
          kind: "resource.disk-limit",
          limitBytes: 100,
          resource: {
            id: "db-a",
            name: "main",
            relayId: "relay-a",
            type: "database",
          },
          usedBytes: 120,
        }
        const key = "resource.disk-limit:database:relay-a:db-a:100"

        yield* TestClock.setTime(1_000)
        yield* notifyUsersEffect(["user-a"], key, warning)
        yield* refreshDiskLimitUsageEffect(key, 10_000_000_000)
        assert.deepStrictEqual(yield* contents("user-a"), [
          {
            content: { ...warning, usedBytes: 10_000_000_000 },
            read: false,
          },
        ])

        // Cleared by the user, then fits: the next overflow is news.
        const [notification] = yield* listNotificationsEffect("user-a")
        yield* dismissNotificationEffect("user-a", notification?.id ?? "")
        const told = yield* sourceKeysEffect(
          "resource.disk-limit",
          "resource.disk-limit:database:relay-a:"
        )
        assert.deepStrictEqual(told, [key])
        yield* forgetNotificationsEffect("resource.disk-limit", told)
        yield* notifyUsersEffect(["user-a"], key, warning)

        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: warning, read: false },
        ])
      })
    )

    it.effect("clears only the user's own notifications, for good", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* insertUser("user-b")

        yield* TestClock.setTime(1_000)
        yield* notifyUsersEffect(
          ["user-a", "user-b"],
          "kiln.release:0.3.0",
          release
        )
        yield* TestClock.setTime(2_000)
        yield* notifyUsersEffect(
          ["user-a"],
          "access.removed:grant-a:2",
          removed
        )
        const [newest, oldest] = yield* listNotificationsEffect("user-a")
        const [othersRelease] = yield* listNotificationsEffect("user-b")

        // Another user's notification ID clears nothing.
        assert.strictEqual(
          yield* dismissNotificationEffect("user-a", othersRelease!.id),
          0
        )
        assert.strictEqual(
          yield* dismissNotificationEffect("user-a", oldest!.id),
          1
        )
        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: false },
        ])
        assert.deepStrictEqual(yield* contents("user-b"), [
          { content: release, read: false },
        ])

        // A later check re-announcing the release can't bring it back.
        yield* notifyUsersEffect(["user-a"], "kiln.release:0.3.0", release)
        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: false },
        ])

        // Clearing all stops at what the user saw.
        yield* TestClock.setTime(3_000)
        yield* notifyUsersEffect(["user-a"], "kiln.release:0.4.0", {
          ...release,
          version: "0.4.0",
        })
        assert.strictEqual(
          yield* clearNotificationsEffect("user-a", newest!.createdAt),
          1
        )
        assert.deepStrictEqual(
          (yield* contents("user-a")).map(({ content }) => content.kind),
          ["kiln.release"]
        )
        assert.deepStrictEqual(yield* contents("user-b"), [
          { content: release, read: false },
        ])
      })
    )
  })
})
