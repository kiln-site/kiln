import { assert, layer } from "@effect/vitest"
import { exclusive } from "@workspace/operations"
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

import { durableOperation, startDurableOperation } from "./durable"
import {
  OperationConflictError,
  hearthDriverId,
  loadOperation,
  recoverOperations,
} from "./lanes"
import { quickOperation, runOperation } from "./run"
import { testOperationsEngine } from "./test/engine"

afterAll(() => disposeAppRuntime())

const write = quickOperation<{ readonly key: string; readonly name: string }>({
  kind: "test.write",
  locks: ({ key }) => [exclusive(key)],
  version: 1,
})

// Runs a quick operation that notes when it starts and holds its locks
// until released.
const hold = (log: Array<string>, key: string, name: string) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const fiber = yield* runOperation(
      write,
      { key, name },
      Effect.sync(() => log.push(name)).pipe(
        Effect.andThen(Deferred.await(release))
      )
    ).pipe(Effect.forkChild)
    return { fiber, release }
  })

const until = (check: () => boolean) =>
  Effect.sync(check).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (done) => done,
    }),
    Effect.timeout("10 seconds")
  )

const states = selectRows<{ kind: string; state: string }>("operation").pipe(
  Effect.map((rows) => rows.map((row) => `${row.kind}:${row.state}`).sort())
)

// A long change that holds a game server until it's done.
const migrate = durableOperation({
  input: Schema.Struct({ server: Schema.String }),
  kind: "test.migrate",
  locks: ({ server }) => [exclusive(`instance:${server}`)],
  run: ({ server }) => Effect.succeed(`moved ${server}`),
  success: Schema.String,
  version: 1,
})

const Lanes = testOperationsEngine(migrate.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

describeMysql("Hearth operation lanes", () => {
  layer(Lanes, { timeout: 60_000 })((it) => {
    it.effect(
      "runs conflicting operations in the order they arrived, and others at once",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const log: Array<string> = []
          const first = yield* hold(log, "server-a", "first")
          yield* until(() => log.includes("first"))
          const second = yield* hold(log, "server-a", "second")
          const other = yield* hold(log, "server-b", "other")
          yield* until(() => log.includes("other"))

          assert.deepStrictEqual(log, ["first", "other"])
          yield* Deferred.succeed(first.release, undefined)
          yield* until(() => log.includes("second"))
          yield* Deferred.succeed(second.release, undefined)
          yield* Deferred.succeed(other.release, undefined)
          yield* Fiber.join(second.fiber)
          yield* Fiber.join(other.fiber)

          assert.deepStrictEqual(log, ["first", "other", "second"])
          assert.deepStrictEqual(yield* states, [
            "test.write:succeeded",
            "test.write:succeeded",
            "test.write:succeeded",
          ])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "frees the locks of work a stopped Hearth was running, for what waits behind it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          // Left running by a Hearth that stopped.
          yield* insertRows("operation", {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "test.write",
            version: 1,
            durable: false,
            sequence: 1,
            input_hash: "0".repeat(64),
            state: "running",
            driver: "00000000-0000-4000-8000-0000000000ff",
            admitted_at: 0,
            updated_at: 0,
          })
          yield* insertRows("operation_lock", {
            operation_id: "00000000-0000-4000-8000-000000000001",
            lock_key: "server-a",
            mode: "exclusive",
            held: true,
          })
          yield* insertRows("operation_scheduler", { id: 1, next_sequence: 2 })
          const log: Array<string> = []
          const waiting = yield* hold(log, "server-a", "after restart")

          yield* recoverOperations()
          yield* until(() => log.includes("after restart"))
          yield* Deferred.succeed(waiting.release, undefined)
          yield* Fiber.join(waiting.fiber)

          assert.deepStrictEqual(yield* states, [
            "test.write:interrupted",
            "test.write:succeeded",
          ])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "starts a durable operation once what it waits on ends, and runs it to the end",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const log: Array<string> = []
          const backup = yield* hold(log, "instance:survival", "backup")
          yield* until(() => log.includes("backup"))

          const id = yield* startDurableOperation(
            migrate,
            { server: "survival" },
            { idempotencyKey: "move-survival" }
          )
          // Started again, it's the same operation; with other input, it's
          // refused.
          assert.strictEqual(
            yield* startDurableOperation(
              migrate,
              { server: "survival" },
              { idempotencyKey: "move-survival" }
            ),
            id
          )
          const refused = yield* startDurableOperation(
            migrate,
            { server: "creative" },
            { idempotencyKey: "move-survival" }
          ).pipe(Effect.flip)
          assert.instanceOf(refused, OperationConflictError)
          assert.strictEqual((yield* loadOperation(id))?.state, "waiting")

          yield* Deferred.succeed(backup.release, undefined)
          yield* Fiber.join(backup.fiber)
          const done = yield* loadOperation(id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (record) => record?.state === "succeeded",
            }),
            Effect.timeout("20 seconds")
          )

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(done?.durable, true)
          assert.isNotNull(done?.executionId)
          assert.deepStrictEqual(
            yield* selectRows("operation_lock"),
            [],
            "every lock is released"
          )
          assert.strictEqual(
            (yield* selectRows<{ driver: string }>("operation")).find(
              (row) => row.driver !== hearthDriverId
            ),
            undefined
          )
        }).pipe(TestClock.withLive)
    )
  })
})
