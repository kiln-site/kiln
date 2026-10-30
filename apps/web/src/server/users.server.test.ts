import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  getUserAccessHandler,
  listManagedUsersHandler,
} from "@/server/users.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

afterAll(() => disposeAppRuntime())

const sessionUser = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("admin", { role: "admin" })
  yield* insertUser("member")
  yield* insertUser("invited")
})

describeMysql("platform users", () => {
  layer(TestDatabase)((it) => {
    it.effect("only platform administrators can list users", () =>
      Effect.gen(function* () {
        yield* seed
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            listManagedUsersHandler(sessionUser("member"), {
              offset: 0,
              limit: 50,
            })
          )
        )
        assert.isTrue(result._tag === "Failure")
      })
    )

    it.effect("only platform administrators can read a user's access", () =>
      Effect.gen(function* () {
        yield* seed
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            getUserAccessHandler(sessionUser("member"), "invited")
          )
        )
        assert.isTrue(result._tag === "Failure")
      })
    )
  })
})
