import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader } from "mysql2/promise"
import { vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import { Database } from "@/effect/database"
import { deletePersistedRelayEffect } from "@/lib/relay-registry"

const removedResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

describe("Relay deletion", () => {
  it.effect("cleans Relay projections before deleting the Relay", () => {
    const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
      []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              statements.push({ sql, values: values ?? [] })
              return removedResult
            }),
          queryRows: () => Effect.die("Unexpected transaction query"),
        }),
    })

    return Effect.gen(function* () {
      yield* deletePersistedRelayEffect("relay-one")

      assert.strictEqual(statements.length, 5)
      assert.include(statements[0]?.sql, "kiln_invitation")
      assert.include(statements[0]?.sql, "revoked_at")
      assert.include(statements[1]?.sql, "kiln_access_grant")
      assert.include(statements[2]?.sql, "kiln_tailscale_network")
      assert.include(statements[2]?.sql, "cleanup_attempts = 0")
      assert.include(statements[2]?.sql, "cleanup_last_error = NULL")
      assert.include(statements[2]?.sql, "NOT EXISTS")
      assert.include(statements[3]?.sql, "kiln_tailscale_network_deployment")
      assert.include(statements[4]?.sql, "kiln_relay")
      assert.deepEqual(
        statements.map(({ values }) => values),
        [
          ["relay-one"],
          ["relay-one"],
          ["relay-one", "relay-one"],
          ["relay-one"],
          ["relay-one"],
        ]
      )
    }).pipe(Effect.provide(databaseLayer))
  })
})
