import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { Database } from "@/effect/database"
import { requireAccountPasswordEffect } from "@/lib/auth-password"

function testDatabase() {
  const state = { queries: 0 }
  const layer = Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected database write"),
    queryRows: () =>
      Effect.sync(() => {
        state.queries += 1
        return []
      }),
    transaction: () => Effect.die("Unexpected database transaction"),
  })
  return { layer, state }
}

describe("account password confirmation", () => {
  afterEach(() => vi.unstubAllEnvs())

  it.effect(
    "accepts an empty password for the development bypass in dev",
    () => {
      vi.stubEnv("KILN_ENVIRONMENT", "dev")
      const database = testDatabase()
      return Effect.gen(function* () {
        yield* requireAccountPasswordEffect(
          {
            id: "kiln-development-bypass",
            isDevelopmentBypass: true,
          },
          ""
        )
        assert.strictEqual(database.state.queries, 0)
      }).pipe(Effect.provide(database.layer))
    }
  )

  it.effect("rejects passwords for the development bypass", () => {
    vi.stubEnv("KILN_ENVIRONMENT", "dev")
    const database = testDatabase()
    return Effect.gen(function* () {
      const failure = yield* requireAccountPasswordEffect(
        {
          id: "kiln-development-bypass",
          isDevelopmentBypass: true,
        },
        "password"
      ).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "AuthenticationError")
      assert.strictEqual(database.state.queries, 0)
    }).pipe(Effect.provide(database.layer))
  })

  it.effect("does not accept an empty password for persisted accounts", () => {
    vi.stubEnv("KILN_ENVIRONMENT", "dev")
    const database = testDatabase()
    return Effect.gen(function* () {
      const failure = yield* requireAccountPasswordEffect(
        {
          id: "persisted-account",
          isDevelopmentBypass: false,
        },
        ""
      ).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "AuthenticationError")
      assert.strictEqual(database.state.queries, 1)
    }).pipe(Effect.provide(database.layer))
  })

  it.effect(
    "does not accept an empty password for another dev identity",
    () => {
      vi.stubEnv("KILN_ENVIRONMENT", "dev")
      const database = testDatabase()
      return Effect.gen(function* () {
        const failure = yield* requireAccountPasswordEffect(
          {
            id: "another-development-user",
            isDevelopmentBypass: true,
          },
          ""
        ).pipe(Effect.flip)
        assert.strictEqual(failure._tag, "AuthenticationError")
        assert.strictEqual(database.state.queries, 1)
      }).pipe(Effect.provide(database.layer))
    }
  )

  it.effect("does not accept an empty password outside development", () => {
    vi.stubEnv("KILN_ENVIRONMENT", "prod")
    const database = testDatabase()
    return Effect.gen(function* () {
      const failure = yield* requireAccountPasswordEffect(
        {
          id: "kiln-development-bypass",
          isDevelopmentBypass: true,
        },
        ""
      ).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "AuthenticationError")
      assert.strictEqual(database.state.queries, 0)
    }).pipe(Effect.provide(database.layer))
  })
})
