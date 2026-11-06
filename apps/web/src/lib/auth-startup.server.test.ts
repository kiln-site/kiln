import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vite-plus/test"

import { databaseTableName } from "@/lib/database-config"
import { applyMigrations } from "@/effect/migrations"
import { migrations } from "@/migrations"
import { describeMysql, testDatabaseClient } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

const origin = "http://localhost:3000"
const password = "correct-horse-battery"
// Building every table takes seconds alone, and minutes beside other schema
// builds on the box's MySQL.
const schemaBuildTimeout = 300_000
// Drops every table, so it gets a database of its own. `@/lib/auth` connects
// to it when imported, which each test does as Hearth's startup would.
const database = `${process.env.DB_NAME}_auth_startup`

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
vi.stubEnv("DB_NAME", database)
vi.stubEnv("KILN_URL", origin)

const dropAllTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* sql<{ name: string }>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE()
  `
  yield* sql`SET FOREIGN_KEY_CHECKS = 0`
  for (const table of tables) yield* sql`DROP TABLE ${sql(table.name)}`
  yield* sql`SET FOREIGN_KEY_CHECKS = 1`
})

const initializeAuth = Effect.promise(async () => {
  vi.resetModules()
  const { auth, checkAuthSchema } = await import("@/lib/auth")
  return { auth, checkAuthSchema, context: await auth.$context }
})

describeMysql("auth startup", () => {
  layer(testDatabaseClient(database))((it) => {
    it.effect(
      "signs in on a new database without a restart",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          // As in Hearth: importing auth comes before migrating.
          const { auth, checkAuthSchema, context } = yield* initializeAuth
          yield* applyMigrations(migrations)
          yield* Effect.promise(checkAuthSchema)

          const now = new Date()
          const hash = yield* Effect.promise(() =>
            context.password.hash(password)
          )
          yield* insertUser("user", {
            manuallyVerifiedAt: now,
            status: "enabled",
          })
          yield* insertRows("account", {
            id: "credential",
            accountId: "user",
            providerId: "credential",
            userId: "user",
            password: hash,
            createdAt: now,
            updatedAt: now,
          })

          const response = yield* Effect.promise(() =>
            auth.handler(
              new Request(`${origin}/api/auth/sign-in/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin },
                body: JSON.stringify({ email: "user@example.test", password }),
              })
            )
          )

          expect(response.status).toBe(200)
          expect(response.headers.getSetCookie().join()).toMatch(/session_token/)
        }),
      { timeout: schemaBuildTimeout }
    )

    it.effect(
      "refuses to start when a migration left the auth tables short",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(migrations)
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            ALTER TABLE ${sql(databaseTableName("session"))} DROP COLUMN userAgent
          `

          const { checkAuthSchema } = yield* initializeAuth

          yield* Effect.promise(() =>
            expect(checkAuthSchema()).rejects.toThrow(/userAgent/)
          )
        }),
      { timeout: schemaBuildTimeout }
    )
  })
})
