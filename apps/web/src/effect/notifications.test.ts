import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { saveNotificationPreferencesEffect } from "@/effect/notification-preferences"
import {
  clearNotificationsEffect,
  dismissNotificationEffect,
  listNotificationsEffect,
  markNotificationsReadEffect,
  notifyUsersEffect,
  replaceNotificationEffect,
  resolveInvitationNotificationsEffect,
  resolveNotificationsEffect,
} from "@/effect/notifications"
import type {
  InvitationOutcome,
  NotificationContent,
} from "@/lib/notifications"
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

// Invitations as the access flow leaves them; unanswered and unexpired
// unless a row says otherwise.
const insertInvitations = (rows: ReadonlyArray<Record<string, unknown>>) =>
  insertRows(
    "invitation",
    rows.map((row) => ({
      token_hash: String(row.id).padEnd(64, "0"),
      email: `${String(row.user_id)}@example.test`,
      invited_by: "owner",
      expires_at: 1_000_000,
      accepted_at: null,
      revoked_at: null,
      created_at: 0,
      ...row,
    }))
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

    it.effect(
      "keeps the actor and users who opted out from hearing of it, for good",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          for (const id of ["user-a", "user-b", "user-c"]) yield* insertUser(id)
          yield* saveNotificationPreferencesEffect("user-c", {
            kinds: { "access.removed": { inbox: false, push: true } },
          })

          yield* notifyUsersEffect(
            ["user-a", "user-b", "user-c"],
            "access.removed:grant-a:1",
            removed,
            { actorUserId: "user-a" }
          )
          // A later, automatic announcement of the same event.
          yield* notifyUsersEffect(
            ["user-a", "user-b", "user-c"],
            "access.removed:grant-a:1",
            removed
          )

          assert.deepStrictEqual(yield* contents("user-a"), [])
          assert.deepStrictEqual(yield* contents("user-b"), [
            { content: removed, read: false },
          ])
          assert.deepStrictEqual(yield* contents("user-c"), [])
        })
    )

    it.effect("clears resolved notifications for everyone who has them", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* insertUser("user-b")
        yield* notifyUsersEffect(
          ["user-a", "user-b"],
          "kiln.release:0.3.0",
          release
        )
        yield* notifyUsersEffect(
          ["user-a"],
          "access.removed:grant-a:1",
          removed
        )

        const changed = yield* resolveNotificationsEffect("kiln.release", [
          "kiln.release:0.3.0",
        ])

        assert.deepStrictEqual([...changed].sort(), ["user-a", "user-b"])
        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: false },
        ])
        assert.deepStrictEqual(yield* contents("user-b"), [])
        // Resolved notifications stay resolved when announced again.
        yield* notifyUsersEffect(["user-b"], "kiln.release:0.3.0", release)
        assert.deepStrictEqual(yield* contents("user-b"), [])
      })
    )

    it.effect(
      "keeps one report, folding in the one it replaces while unread",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")
          yield* insertUser("user-b")
          const report = (count: number): NotificationContent => ({
            count,
            kind: "security.report",
            knownExploited: 0,
            resources: [removed.resource],
            severity: "high",
          })
          // Adds the unread reports' counts to the news.
          const replace = (userId: string, count: number) =>
            replaceNotificationEffect(userId, "security.report", (unread) =>
              report(
                unread.reduce(
                  (sum, content) =>
                    content.kind === "security.report"
                      ? sum + content.count
                      : sum,
                  count
                )
              )
            )

          yield* TestClock.setTime(1_000)
          yield* replace("user-a", 2)
          yield* replace("user-b", 1)
          yield* notifyUsersEffect(
            ["user-a"],
            "access.removed:grant-a:1",
            removed
          )
          yield* TestClock.setTime(2_000)
          yield* replace("user-a", 3)
          // The new report is the newest, and the others' report is theirs.
          assert.deepStrictEqual(yield* contents("user-a"), [
            { content: report(5), read: false },
            { content: removed, read: false },
          ])
          assert.deepStrictEqual(yield* contents("user-b"), [
            { content: report(1), read: false },
          ])

          // One already read is replaced by just the news.
          yield* markNotificationsReadEffect("user-a", "all")
          yield* replace("user-a", 4)
          assert.deepStrictEqual(yield* contents("user-a"), [
            { content: report(4), read: false },
            { content: removed, read: true },
          ])

          // And after it's cleared, the news arrives on its own.
          yield* clearNotificationsEffect("user-a", 2_000)
          yield* TestClock.setTime(3_000)
          yield* replace("user-a", 1)
          assert.deepStrictEqual(yield* contents("user-a"), [
            { content: report(1), read: false },
          ])
        })
    )

    it.effect("marks only the user's own notifications read", () =>
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
        const [othersRelease] = yield* listNotificationsEffect("user-b")
        const [ownRemoval] = yield* listNotificationsEffect("user-a")

        // Another user's notification ID marks nothing.
        assert.deepStrictEqual(
          yield* markNotificationsReadEffect("user-a", [othersRelease!.id]),
          []
        )
        assert.deepStrictEqual(
          yield* markNotificationsReadEffect("user-a", [ownRemoval!.id]),
          [ownRemoval!.id]
        )
        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: removed, read: true },
          { content: release, read: false },
        ])

        // Reading everything stays in the user's own inbox and reports only
        // what was still new.
        assert.strictEqual(
          (yield* markNotificationsReadEffect("user-a", "all")).length,
          1
        )
        assert.deepStrictEqual(
          yield* markNotificationsReadEffect("user-a", "all"),
          []
        )
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

    it.effect("records an invitation's answer in the invitee's inbox", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* insertUser("user-b")
        const invited = (
          invitationId: string,
          outcome?: InvitationOutcome
        ): NotificationContent => ({
          actorName: "Owner",
          invitationId,
          kind: "access.invited",
          ...(outcome ? { outcome } : {}),
          resource: removed.resource,
        })
        yield* insertInvitations([
          { id: "inv-a", user_id: "user-a" },
          { id: "inv-b", user_id: "user-a" },
          { id: "inv-c", user_id: "user-a" },
          { id: "inv-d", user_id: "user-b" },
        ])
        yield* TestClock.setTime(1_000)
        yield* notifyUsersEffect(
          ["user-a"],
          "access.invited:inv-a",
          invited("inv-a")
        )
        yield* TestClock.setTime(1_500)
        yield* notifyUsersEffect(
          ["user-a"],
          "access.invited:inv-c",
          invited("inv-c")
        )
        yield* TestClock.setTime(2_000)
        yield* notifyUsersEffect(
          ["user-a"],
          "access.invited:inv-b",
          invited("inv-b")
        )
        yield* notifyUsersEffect(
          ["user-b"],
          "access.invited:inv-d",
          invited("inv-d")
        )

        // An answer marks the notification read; a cancellation stays unread
        // so the user notices it.
        yield* resolveInvitationNotificationsEffect(
          "user-a",
          ["inv-a"],
          "accepted"
        )
        yield* resolveInvitationNotificationsEffect(
          "user-a",
          ["inv-b"],
          "cancelled"
        )
        yield* resolveInvitationNotificationsEffect(
          "user-a",
          ["inv-c"],
          "declined"
        )

        assert.deepStrictEqual(yield* contents("user-a"), [
          { content: invited("inv-b", "cancelled"), read: false },
          { content: invited("inv-c", "declined"), read: true },
          { content: invited("inv-a", "accepted"), read: true },
        ])
        assert.deepStrictEqual(yield* contents("user-b"), [
          { content: invited("inv-d"), read: false },
        ])
      })
    )

    it.effect("shows what became of invitations answered elsewhere", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* TestClock.setTime(10_000)
        // Notifications written before outcomes were recorded, or whose
        // invitation changed without them, carry no outcome of their own.
        yield* insertInvitations([
          { id: "pending", user_id: "user-a" },
          { id: "expired", user_id: "user-a", expires_at: 10_000 },
          { id: "accepted", user_id: "user-a", accepted_at: 5_000 },
          { id: "revoked", user_id: "user-a", revoked_at: 5_000 },
          { id: "other-user", user_id: "user-b" },
        ])
        const ids = ["pending", "expired", "accepted", "revoked", "other-user"]
        for (const [index, id] of ids.entries()) {
          yield* TestClock.setTime(1_000 + index)
          yield* notifyUsersEffect(["user-a"], `access.invited:${id}`, {
            actorName: "Owner",
            invitationId: id,
            kind: "access.invited",
            resource: removed.resource,
          })
        }
        yield* TestClock.setTime(10_000)

        assert.deepStrictEqual(
          (yield* listNotificationsEffect("user-a")).map(({ content }) =>
            content.kind === "access.invited"
              ? [content.invitationId, content.outcome ?? "pending"]
              : null
          ),
          [
            // Another user's invitation is never this user's to answer.
            ["other-user", "cancelled"],
            ["revoked", "cancelled"],
            ["accepted", "accepted"],
            ["expired", "expired"],
            ["pending", "pending"],
          ]
        )
      })
    )

    it.effect(
      "reads per-resource vulnerability notifications as reports it replaces",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")
          const report = (
            count: number,
            knownExploited: number
          ): NotificationContent => ({
            count,
            kind: "security.report",
            knownExploited,
            resources: [removed.resource],
            severity: "critical",
          })
          // Adds every unread report to the news.
          const replace = (count: number) =>
            replaceNotificationEffect("user-a", "security.report", (unread) => {
              let exploited = 0
              for (const content of unread)
                if (content.kind === "security.report") {
                  count += content.count
                  exploited += content.knownExploited
                }
              return report(count, exploited)
            })

          yield* TestClock.setTime(1_000)
          yield* replace(1)
          // As a Hearth from before reports writes it, after this one's
          // report arrived.
          yield* insertRows("notification", {
            id: "00000000-0000-4000-8000-0000000000b1",
            user_id: "user-a",
            kind: "security.vulnerabilities",
            source_key: "security:app:app-a:1",
            data: JSON.stringify({
              component: null,
              count: 2,
              fixable: 1,
              knownExploited: 1,
              resource: removed.resource,
              severity: "critical",
              top: {
                fixedVersion: null,
                id: "CVE-1",
                packageName: "openssl",
                packageVersion: "1",
              },
            }),
            created_at: 2_000,
          })
          assert.deepStrictEqual(yield* contents("user-a"), [
            { content: report(2, 1), read: false },
            { content: report(1, 0), read: false },
          ])

          // Neither was read, so the next report holds both.
          yield* TestClock.setTime(3_000)
          yield* replace(3)
          assert.deepStrictEqual(yield* contents("user-a"), [
            { content: report(6, 1), read: false },
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
