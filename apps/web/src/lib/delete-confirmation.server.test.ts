import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

import { requireDeleteConfirmationEffect } from "./delete-confirmation.server"

// Better Auth only supplies the password verifier here.
const verified = vi.hoisted(() => ({ count: 0 }))
vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: {
        verify: async (input: { hash: string; password: string }) => {
          verified.count += 1
          return input.hash === `hashed:${input.password}`
        },
      },
    }),
  },
}))

const owner = {
  email: "owner@example.test",
  emailVerified: true,
  id: "owner",
  isDevelopmentBypass: false,
  name: "Owner",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const seed = Effect.gen(function* () {
  yield* resetDatabase
  verified.count = 0
  yield* insertUser(owner.id)
  yield* insertRows("account", {
    accountId: owner.id,
    createdAt: new Date(0),
    id: "credential",
    password: "hashed:correct horse battery",
    providerId: "credential",
    updatedAt: new Date(0),
    userId: owner.id,
  })
})

const confirm = (confirmation: string, password: string) =>
  requireDeleteConfirmationEffect({
    confirmation,
    name: "Survival",
    password,
    user: owner,
  })

describeMysql("deletion confirmation", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "refuses a name that isn't the resource's without trying the password",
      () =>
        Effect.gen(function* () {
          yield* seed

          const refused = yield* Effect.flip(
            confirm("Survival 2", "correct horse battery")
          )

          assert.strictEqual(refused._tag, "AuthenticationError")
          assert.include(refused.message, "Survival")
          assert.strictEqual(verified.count, 0)
        })
    )

    it.effect("refuses the wrong account password", () =>
      Effect.gen(function* () {
        yield* seed

        const refused = yield* Effect.flip(confirm("Survival", "wrong"))

        assert.strictEqual(refused._tag, "AuthenticationError")
      })
    )

    it.effect(
      "stops checking passwords after five wrong ones, the right one too",
      () =>
        Effect.gen(function* () {
          yield* seed
          for (let attempt = 0; attempt < 5; attempt += 1) {
            yield* Effect.flip(confirm("Survival", `wrong ${attempt}`))
          }
          const checked = verified.count

          const refused = yield* Effect.flip(
            confirm("Survival", "correct horse battery")
          )

          assert.strictEqual(refused._tag, "PasswordAttemptsError")
          assert.strictEqual(verified.count, checked)
        })
    )

    it.effect(
      "checks no more than five passwords when ten wrong ones arrive at once",
      () =>
        Effect.gen(function* () {
          yield* seed

          const refusals = yield* Effect.all(
            Array.from({ length: 10 }, (_, attempt) =>
              Effect.flip(confirm("Survival", `wrong ${attempt}`))
            ),
            { concurrency: "unbounded" }
          )

          assert.isAtMost(verified.count, 5)
          assert.isTrue(
            refusals.every(
              (refused) =>
                refused._tag === "AuthenticationError" ||
                refused._tag === "PasswordAttemptsError"
            )
          )
          // Spent: the right one waits too.
          const after = yield* Effect.flip(
            confirm("Survival", "correct horse battery")
          )
          assert.strictEqual(after._tag, "PasswordAttemptsError")
        })
    )

    it.effect(
      "accepts more right passwords in a row than the wrong ones allowed",
      () =>
        Effect.gen(function* () {
          yield* seed

          // A right password frees its attempt, so none of these counts.
          for (let attempt = 0; attempt < 6; attempt += 1) {
            yield* confirm("Survival", "correct horse battery")
          }

          assert.strictEqual(verified.count, 6)
        })
    )

    it.effect(
      "accepts the name, typed with stray spaces, and the password",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* confirm("  Survival ", "correct horse battery")
        })
    )
  })
})
