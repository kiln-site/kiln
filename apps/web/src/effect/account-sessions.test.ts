import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  accountSessionActiveEffect,
  listAccountSessionsEffect,
  revokeAccountSessionEffect,
} from "@/effect/account-sessions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

const now = Date.UTC(2026, 7, 23, 12)

const insertSession = (id: string, userId: string, expiresAt: number) =>
  insertRows("session", {
    id,
    token: `token-${id}`,
    userId,
    expiresAt: new Date(expiresAt),
    createdAt: new Date(now - 60_000),
    updatedAt: new Date(now - 60_000),
    ipAddress: "203.0.113.1",
    userAgent: "Kiln test browser",
  })

const seedSessions = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
  yield* insertSession("session-own", "user-one", now + 60_000)
  yield* insertSession("session-expired", "user-one", now - 1)
  yield* insertSession("session-foreign", "user-two", now + 60_000)
})

describeMysql("account sessions", () => {
  layer(TestDatabase)((it) => {
    it.effect("lists only the user's unexpired sessions without secrets", () =>
      Effect.gen(function* () {
        yield* seedSessions

        const sessions = yield* listAccountSessionsEffect("user-one")

        assert.deepStrictEqual(sessions, [
          {
            createdAt: new Date(now - 60_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
            id: "session-own",
            ipAddress: "203.0.113.1",
            userAgent: "Kiln test browser",
          },
        ])
      })
    )

    it.effect("revokes only the user's own session", () =>
      Effect.gen(function* () {
        yield* seedSessions

        const foreign = yield* revokeAccountSessionEffect(
          "user-one",
          "session-foreign"
        )
        const own = yield* revokeAccountSessionEffect("user-one", "session-own")

        assert.isNull(foreign)
        assert.isNotNull(own)
        const remaining = yield* selectRows<{ id: string }>("session")
        assert.sameMembers(
          remaining.map((row) => row.id),
          ["session-expired", "session-foreign"]
        )
      })
    )

    it.effect("treats only the user's exact unexpired session as active", () =>
      Effect.gen(function* () {
        yield* seedSessions

        assert.isTrue(
          yield* accountSessionActiveEffect("user-one", "session-own")
        )
        assert.isFalse(
          yield* accountSessionActiveEffect("user-one", "session-expired")
        )
        assert.isFalse(
          yield* accountSessionActiveEffect("user-one", "session-foreign")
        )
      })
    )
  })
})
