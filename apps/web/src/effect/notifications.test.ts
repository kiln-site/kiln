import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  clearNotificationsEffect,
  dismissNotificationEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  notifyUsersEffect,
} from "@/effect/notifications"
import type { NotificationContent } from "@/lib/notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

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

        // Reading stops at what the user saw and never touches other users.
        assert.strictEqual(
          yield* markNotificationsReadEffect("user-a", 1_000),
          1
        )
        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: false },
          { content: release, read: true },
        ])
        assert.deepStrictEqual(yield* contents("user-b"), [
          { content: release, read: false },
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

    it.effect("skips notifications this version cannot show", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* notifyUsersEffect(["user-a"], "kiln.release:0.3.0", release)
        yield* insertRows("notification", [
          {
            id: "00000000-0000-4000-8000-0000000000a1",
            user_id: "user-a",
            kind: "announcement.future",
            source_key: "announcement:1",
            data: JSON.stringify({ title: "From a newer Kiln" }),
            created_at: 5_000,
          },
          {
            id: "00000000-0000-4000-8000-0000000000a2",
            user_id: "user-a",
            kind: "kiln.release",
            source_key: "kiln.release:broken",
            data: JSON.stringify({ version: "0.4.0" }),
            created_at: 6_000,
          },
        ])

        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: release, read: false },
        ])
      })
    )
  })
})
