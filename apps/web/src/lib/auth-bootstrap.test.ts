import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import { replacePendingAccountEmailEffect } from "@/lib/auth-bootstrap"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

// Better Auth is never reached by the guarded write; skip its configuration.
vi.mock("@/lib/auth", () => ({ auth: {} }))

const input = {
  userId: "pending",
  currentEmail: "old@example.test",
  nextEmail: "new@example.test",
  passwordHash: "verified-hash",
  role: "user",
}

const at = new Date(Date.UTC(2026, 0, 1))
const session = (id: string, userId: string) => ({
  id,
  userId,
  token: id,
  expiresAt: new Date(Date.UTC(2099, 0, 1)),
  createdAt: at,
  updatedAt: at,
})

const seedPendingAccount = (overrides: {
  password?: string
  emailVerifiedAt?: Date | null
}) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertUser("pending", {
      email: input.currentEmail,
      emailVerified: false,
      role: "user",
      emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    })
    yield* insertUser("bystander")
    yield* insertRows("account", {
      id: "credential",
      accountId: "pending",
      providerId: "credential",
      userId: "pending",
      password: overrides.password ?? input.passwordHash,
      createdAt: at,
      updatedAt: at,
    })
    yield* insertRows("session", [
      session("old-session", "pending"),
      session("bystander-session", "bystander"),
    ])
  })

const state = Effect.gen(function* () {
  const users = yield* selectRows<{ id: string; email: string }>("user")
  const sessions = yield* selectRows<{ id: string }>("session")
  const audit = yield* selectRows<{ event: string }>("auth_audit")
  return {
    email: users.find((user) => user.id === "pending")?.email,
    sessions: sessions.map((row) => row.id).sort(),
    audit: audit.map((row) => row.event),
  }
})

describeMysql("pending email correction race", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "rejects a stale password or verification snapshot without invalidating sessions or writing audit",
      () =>
        Effect.gen(function* () {
          for (const stale of [
            { password: "rotated-hash" },
            { emailVerifiedAt: at },
          ]) {
            yield* seedPendingAccount(stale)
            const error = yield* Effect.flip(
              replacePendingAccountEmailEffect(input)
            )
            expect(error.message).toContain("can no longer be changed")
            expect(yield* state).toEqual({
              email: input.currentEmail,
              sessions: ["bystander-session", "old-session"],
              audit: [],
            })
          }
        })
    )

    it.effect(
      "changes the same identity and invalidates only its old-address sessions",
      () =>
        Effect.gen(function* () {
          yield* seedPendingAccount({})

          const result = yield* replacePendingAccountEmailEffect(input)

          expect(result.sessionIds).toEqual(["old-session"])
          expect(yield* state).toEqual({
            email: input.nextEmail,
            sessions: ["bystander-session"],
            audit: ["account.pending-email.changed"],
          })
        })
    )
  })
})
