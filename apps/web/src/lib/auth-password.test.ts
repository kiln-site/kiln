import { afterEach, assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import { requireAccountPasswordEffect } from "@/lib/auth-password"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

// Better Auth only supplies the password verifier here.
vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: {
        verify: async (input: { hash: string; password: string }) =>
          input.hash === `hashed:${input.password}`,
      },
    }),
  },
}))

const bypass = { id: "kiln-development-bypass", isDevelopmentBypass: true }

const seedAccount = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("persisted-account")
  yield* insertRows("account", {
    id: "credential",
    accountId: "persisted-account",
    providerId: "credential",
    userId: "persisted-account",
    password: "hashed:correct horse battery",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })
})

const rejected = (
  user: { id: string; isDevelopmentBypass: boolean },
  password: string
) =>
  Effect.map(
    Effect.flip(requireAccountPasswordEffect(user, password)),
    (failure) => failure._tag
  )

describeMysql("account password confirmation", () => {
  afterEach(() => vi.unstubAllEnvs())

  layer(TestDatabase)((it) => {
    it.effect(
      "accepts only an empty password for the development bypass in dev",
      () =>
        Effect.gen(function* () {
          vi.stubEnv("KILN_ENVIRONMENT", "dev")
          yield* resetDatabase
          yield* requireAccountPasswordEffect(bypass, "")
          assert.strictEqual(
            yield* rejected(bypass, "password"),
            "AuthenticationError"
          )
        })
    )

    it.effect("does not accept an empty password outside development", () =>
      Effect.gen(function* () {
        vi.stubEnv("KILN_ENVIRONMENT", "prod")
        yield* resetDatabase
        assert.strictEqual(yield* rejected(bypass, ""), "AuthenticationError")
      })
    )

    it.effect(
      "checks persisted accounts and other dev identities against their credential",
      () =>
        Effect.gen(function* () {
          vi.stubEnv("KILN_ENVIRONMENT", "dev")
          yield* seedAccount
          const persisted = {
            id: "persisted-account",
            isDevelopmentBypass: false,
          }

          yield* requireAccountPasswordEffect(
            persisted,
            "correct horse battery"
          )
          for (const [user, password] of [
            [persisted, ""],
            [persisted, "wrong password"],
            [{ ...persisted, isDevelopmentBypass: true }, ""],
            [{ id: "no-credential", isDevelopmentBypass: true }, ""],
          ] as const) {
            assert.strictEqual(
              yield* rejected(user, password),
              "AuthenticationError"
            )
          }
        })
    )
  })
})
