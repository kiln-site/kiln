import { assert, beforeEach, describe, layer } from "@effect/vitest"
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"

import { Database, makeDatabase } from "@/effect/database"

const state = {
  statements: [] as Array<string>,
  released: 0,
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
  executeUnprepared: (sql) => record(sql, []),
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
    state.gate = undefined
  })

  layer(DatabaseTest)((it) => {
    it.effect("commits successful workflows and releases the connection", () =>
      Effect.gen(function* () {
        const service = yield* Database
        const result = yield* service.transaction(
          "database.test.success",
          (transaction) => transaction.execute("UPDATE kiln_test SET value = 1")
        )

        assert.strictEqual(result.affectedRows, 1)
        assert.deepStrictEqual(state.statements, [
          "BEGIN",
          "UPDATE kiln_test SET value = 1",
          "COMMIT",
        ])
        assert.strictEqual(state.released, 1)
      })
    )

    it.effect(
      "rolls back failed workflows and preserves their typed error",
      () =>
        Effect.gen(function* () {
          const service = yield* Database
          const failure = yield* service
            .transaction("database.test.failure", () =>
              Effect.fail("workflow failure")
            )
            .pipe(Effect.flip)

          assert.strictEqual(failure, "workflow failure")
          assert.deepStrictEqual(state.statements, ["BEGIN", "ROLLBACK"])
          assert.strictEqual(state.released, 1)
        })
    )

    it.effect("rolls back and releases the connection when interrupted", () =>
      Effect.gen(function* () {
        const service = yield* Database
        const started = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          service.transaction("database.test.interrupt", () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never)
            )
          )
        )

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)

        assert.deepStrictEqual(state.statements, ["BEGIN", "ROLLBACK"])
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
