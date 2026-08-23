import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import {
  listAccountSessionsEffect,
  revokeAccountSessionEffect,
} from "@/effect/account-sessions"
import { Database } from "@/effect/database"

const successfulWrite: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

describe("account sessions", () => {
  it.effect(
    "returns only the authenticated user's non-secret session data",
    () => {
      const statements: Array<Statement> = []
      const databaseLayer = accountSessionDatabaseLayer({
        rows: [
          sessionRow("session-own", "user-one"),
          sessionRow("session-foreign", "user-two"),
        ],
        statements,
      })

      return Effect.gen(function* () {
        const sessions = yield* listAccountSessionsEffect("user-one")

        assert.deepStrictEqual(
          sessions.map((session) => session.id),
          ["session-own"]
        )
        assert.isFalse("token" in sessions[0]!)
        assert.match(statements[0]!.sql, /WHERE userId = \?/u)
        assert.deepStrictEqual(statements[0]!.values, ["user-one"])
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect("scopes revocation to the authenticated user", () => {
    const statements: Array<Statement> = []
    const databaseLayer = accountSessionDatabaseLayer({ rows: [], statements })

    return Effect.gen(function* () {
      yield* revokeAccountSessionEffect("user-one", "session-target")

      assert.match(statements[0]!.sql, /WHERE id = \?\s+AND userId = \?/u)
      assert.deepStrictEqual(statements[0]!.values, [
        "session-target",
        "user-one",
      ])
    }).pipe(Effect.provide(databaseLayer))
  })
})

interface Statement {
  sql: string
  values: ReadonlyArray<unknown>
}

function sessionRow(id: string, userId: string) {
  return {
    created_at: new Date("2026-08-23T12:00:00.000Z"),
    expires_at: new Date("2026-08-30T12:00:00.000Z"),
    id,
    ip_address: "203.0.113.1",
    user_agent: "Kiln test browser",
    user_id: userId,
  }
}

function accountSessionDatabaseLayer(input: {
  rows: ReadonlyArray<ReturnType<typeof sessionRow>>
  statements: Array<Statement>
}) {
  return Layer.succeed(Database)({
    execute: (_operation, sql, values) =>
      Effect.sync(() => {
        input.statements.push({ sql, values: values ?? [] })
        return successfulWrite
      }),
    queryRows: <TRow extends RowDataPacket>(
      _operation: string,
      sql: string,
      values?: Array<boolean | Buffer | Date | null | number | string>
    ) =>
      Effect.sync(() => {
        input.statements.push({ sql, values: values ?? [] })
        return input.rows as unknown as ReadonlyArray<TRow>
      }),
    transaction: () => Effect.die("Unexpected account session transaction"),
  })
}
