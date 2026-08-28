import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader } from "mysql2/promise"

import { Database } from "@/effect/database"

import {
  requestTailscaleNetworkCleanupEffect,
  tailscaleCleanupRetryDelaySeconds,
} from "./tailscale-cleanup"

const emptyResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 1,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const statements: Array<{
  sql: string
  values: ReadonlyArray<unknown>
}> = []

const databaseLayer = Layer.succeed(Database)({
  execute: () => Effect.die("Unexpected standalone database write"),
  queryRows: () => Effect.die("Unexpected database query"),
  transaction: (_operation, run) =>
    run({
      execute: (sql, values) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return emptyResult
        }),
      queryRows: () => Effect.die("Unexpected transaction query"),
    }),
})

describe("Tailscale cleanup retries", () => {
  it("backs off quickly and caps retries at five minutes", () => {
    assert.deepEqual(
      [1, 2, 3, 8, 9, 20].map(tailscaleCleanupRetryDelaySeconds),
      [2, 4, 8, 256, 300, 300]
    )
  })

  it.effect("keeps previously observed offline Relays queued", () =>
    Effect.gen(function* () {
      statements.length = 0

      yield* requestTailscaleNetworkCleanupEffect(
        "a".repeat(40),
        "user-one",
        []
      )

      assert.strictEqual(statements.length, 1)
      assert.include(statements[0]?.sql, "deletion_requested_at")
      assert.notInclude(statements[0]?.sql, "DELETE")
      assert.deepEqual(statements[0]?.values, ["user-one", "a".repeat(40)])
    }).pipe(Effect.provide(databaseLayer))
  )
})
