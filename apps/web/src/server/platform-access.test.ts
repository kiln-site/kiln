import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import { Database } from "@/effect/database"
import {
  assignPlatformAccessEffect,
  removePlatformAccessEffect,
} from "@/lib/platform-access"

const emptyResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

interface TestPlatformUser {
  email: string
  id: string
  role: string
  status?: "enabled" | "disabled"
}

describe("platform access changes", () => {
  it.effect(
    "preserves scoped grants and credentials while revising authority on promotion",
    () => {
      const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
        []
      const databaseLayer = platformDatabaseLayer({
        admins: [{ email: "admin@example.com", id: "admin", role: "admin" }],
        statements,
        target: { email: "operator@example.com", id: "operator", role: "user" },
      })

      return Effect.gen(function* () {
        yield* assignPlatformAccessEffect({
          accessType: "platform_admin",
          actingUserId: "admin",
          developmentBypass: false,
          userId: "operator",
        })

        assert.isFalse(
          statements.some(({ sql }) => sql.includes("DELETE grant_row"))
        )
        assert.isFalse(
          statements.some(({ sql }) => /DELETE FROM .*session/u.test(sql))
        )
        assert.isFalse(
          statements.some(({ sql }) => sql.includes("kiln_cli_credential"))
        )
        assert.isTrue(
          statements.some(({ sql }) => sql.includes("authorization_subject"))
        )
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect("protects the last platform administrator", () => {
    const target = {
      email: "admin@example.com",
      id: "admin-one",
      role: "admin",
    }
    const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
      []
    const databaseLayer = platformDatabaseLayer({
      admins: [target],
      statements,
      target,
    })

    return Effect.gen(function* () {
      const error = yield* removePlatformAccessEffect({
        actingUserId: target.id,
        developmentBypass: false,
        targetUserId: target.id,
      }).pipe(Effect.flip)

      assert.strictEqual(
        error.message,
        "At least one Platform Admin is required"
      )
      assert.strictEqual(statements.length, 0)
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect(
    "does not count disabled administrators as a usable replacement",
    () => {
      const target = {
        email: "admin@example.com",
        id: "admin-one",
        role: "admin",
      }
      const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
        []
      const databaseLayer = platformDatabaseLayer({
        admins: [
          target,
          {
            email: "disabled@example.com",
            id: "admin-two",
            role: "admin",
            status: "disabled",
          },
        ],
        statements,
        target,
      })
      return Effect.gen(function* () {
        const error = yield* removePlatformAccessEffect({
          actingUserId: target.id,
          developmentBypass: false,
          targetUserId: target.id,
        }).pipe(Effect.flip)
        assert.strictEqual(
          error.message,
          "At least one Platform Admin is required"
        )
        assert.strictEqual(statements.length, 0)
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect(
    "rechecks the assigning administrator inside the transaction",
    () => {
      const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
        []
      const databaseLayer = platformDatabaseLayer({
        admins: [{ email: "admin@example.com", id: "admin", role: "admin" }],
        statements,
        target: { email: "operator@example.com", id: "operator", role: "user" },
      })

      return Effect.gen(function* () {
        const error = yield* assignPlatformAccessEffect({
          accessType: "platform_admin",
          actingUserId: "former-admin",
          developmentBypass: false,
          userId: "operator",
        }).pipe(Effect.flip)

        assert.strictEqual(
          error.message,
          "Only a platform administrator can assign platform access"
        )
        assert.strictEqual(statements.length, 0)
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect(
    "demotes a platform member while preserving scoped grants and credentials",
    () => {
      const target = {
        email: "creator@example.com",
        id: "creator",
        role: "relay_creator",
      }
      const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
        []
      const databaseLayer = platformDatabaseLayer({
        admins: [{ email: "admin@example.com", id: "admin", role: "admin" }],
        statements,
        target,
      })

      return Effect.gen(function* () {
        yield* removePlatformAccessEffect({
          actingUserId: "admin",
          developmentBypass: false,
          targetUserId: target.id,
        })

        assert.isTrue(
          statements.some(
            ({ sql, values }) =>
              sql.includes("SET role = 'user'") && values[0] === target.id
          )
        )
        assert.isTrue(
          statements.some(
            ({ sql, values }) =>
              sql.includes("kiln_invitation") &&
              sql.includes("access_type <> 'scoped'") &&
              values[1] === target.id
          )
        )
        assert.isFalse(
          statements.some(({ sql }) => /DELETE FROM .*session/u.test(sql))
        )
        assert.isFalse(
          statements.some(({ sql }) => sql.includes("kiln_cli_credential"))
        )
      }).pipe(Effect.provide(databaseLayer))
    }
  )
})

function platformDatabaseLayer(input: {
  admins: ReadonlyArray<TestPlatformUser>
  statements: Array<{ sql: string; values: ReadonlyArray<unknown> }>
  target: TestPlatformUser
}) {
  return Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected standalone database write"),
    queryRows: () => Effect.die("Unexpected standalone database query"),
    transaction: (_operation, run) =>
      run({
        execute: (sql, values) =>
          Effect.sync(() => {
            input.statements.push({ sql, values: values ?? [] })
            return emptyResult
          }),
        queryRows: <TRow extends RowDataPacket>(sql: string) =>
          Effect.succeed(
            (sql.includes("WHERE role = 'admin'")
              ? input.admins.map((user) => ({
                  emailVerifiedAt: new Date(0),
                  ...user,
                }))
              : [
                  { emailVerifiedAt: new Date(0), ...input.target },
                ]) as unknown as ReadonlyArray<TRow>
          ),
      }),
  })
}
