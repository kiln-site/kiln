import { assert, beforeEach, describe, layer } from "@effect/vitest"
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"
import { SqlError, UnknownError } from "effect/sql/SqlError"

import { Database, makeDatabase } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"

const state = {
  statements: [] as Array<string>,
  released: 0,
  failCommit: false,
  // Holds the next prepared statement open until the test finishes it.
  gate: undefined as
    | { started: Deferred.Deferred<void>; finish: Deferred.Deferred<void> }
    | undefined,
}

const record = <TResult>(sql: string, result: TResult) =>
  Effect.sync(() => {
    state.statements.push(sql)
    return result
  })

const connection: Connection = {
  execute: (sql) => record(sql, []),
  executeRaw: (sql) =>
    Effect.gen(function* () {
      const gate = state.gate
      state.gate = undefined
      state.statements.push(sql)
      if (gate) {
        yield* Deferred.succeed(gate.started, undefined)
        yield* Deferred.await(gate.finish)
      }
      return { affectedRows: 1 }
    }),
  executeStream: () => Stream.die("unused"),
  executeUnprepared: (sql) =>
    sql === "COMMIT" && state.failCommit
      ? record(sql, []).pipe(
          Effect.andThen(
            Effect.fail(
              new SqlError({
                reason: new UnknownError({
                  cause: new Error("commit failed"),
                  message: "commit failed",
                  operation: "execute",
                }),
              })
            )
          )
        )
      : record(sql, []),
  executeValues: (sql) => record(sql, []),
  executeValuesUnprepared: (sql) => record(sql, []),
}

const DatabaseTest = Layer.effect(Database)(
  SqlClient.make({
    acquirer: Effect.succeed(connection),
    transactionAcquirer: Effect.acquireRelease(Effect.succeed(connection), () =>
      Effect.sync(() => {
        state.released += 1
      })
    ),
    compiler: MysqlClient.makeCompiler(),
    spanAttributes: [],
  }).pipe(Effect.map((sql) => makeDatabase(Effect.succeed(sql))))
).pipe(Layer.provide(Reactivity.layer))

describe("Database transactions", () => {
  beforeEach(() => {
    state.statements = []
    state.released = 0
    state.failCommit = false
    state.gate = undefined
  })

  layer(DatabaseTest)((it) => {
    it.effect("reports a failed commit as a database error", () =>
      Effect.gen(function* () {
        state.failCommit = true
        const service = yield* Database
        const failure = yield* service
          .transaction("database.test.commit", (transaction) =>
            transaction.execute("UPDATE kiln_test SET value = 1")
          )
          .pipe(Effect.flip)

        assert.instanceOf(failure, DatabaseError)
        assert.strictEqual(failure.operation, "database.test.commit")
        assert.strictEqual(state.released, 1)
      })
    )

    it.effect("waits for an in-flight query before rollback and release", () =>
      Effect.gen(function* () {
        const gate = {
          started: yield* Deferred.make<void>(),
          finish: yield* Deferred.make<void>(),
        }
        state.gate = gate

        const service = yield* Database
        const fiber = yield* Effect.forkChild(
          service.transaction(
            "database.test.inFlightInterrupt",
            (transaction) =>
              transaction.execute("UPDATE kiln_test SET value = 1")
          )
        )

        yield* Deferred.await(gate.started)
        yield* Effect.sync(() => {
          fiber.interruptUnsafe()
        })
        yield* Effect.yieldNow

        assert.deepStrictEqual(state.statements, [
          "BEGIN",
          "UPDATE kiln_test SET value = 1",
        ])
        assert.strictEqual(state.released, 0)

        yield* Deferred.succeed(gate.finish, undefined)
        yield* Fiber.await(fiber)

        assert.deepStrictEqual(state.statements, [
          "BEGIN",
          "UPDATE kiln_test SET value = 1",
          "ROLLBACK",
        ])
        assert.strictEqual(state.released, 1)
      })
    )
  })
})
