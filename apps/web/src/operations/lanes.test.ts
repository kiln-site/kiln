import { assert, layer } from "@effect/vitest"
import { exclusive } from "@workspace/operations"
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

import { durableOperation } from "./durable"
import { OperationEndedError, recoverOperations } from "./lanes"
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
      "doesn't run a change taken from it between its grant and its start",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const database = yield* Database
          // Another Hearth takes it over just as it starts, after it waited
          // its turn: one granted as it's admitted starts in that same step.
          const takenOver = Database.of({
            ...database,
            execute: (operation, statement, values) =>
              operation === "operations.start"
                ? database
                    .execute(
                      "test.takeOver",
                      `UPDATE ${databaseTable("operation")}
                          SET state = 'interrupted' WHERE state = 'granted'`
                    )
                    .pipe(
                      Effect.andThen(
                        database.execute(operation, statement, values)
                      )
                    )
                : database.execute(operation, statement, values),
          })
          const log: Array<string> = []
          const first = yield* hold(log, "server-a", "first")
          yield* until(() => log.includes("first"))
          const late = yield* runOperation(
            write,
            { key: "server-a", name: "late" },
            Effect.sync(() => log.push("late"))
          ).pipe(
            Effect.provideService(Database, takenOver),
            Effect.flip,
            Effect.forkChild
          )
          yield* states.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.includes("test.write:waiting"),
            })
          )
          yield* Deferred.succeed(first.release, undefined)
          yield* Fiber.join(first.fiber)
          const refused = yield* Fiber.join(late)

          assert.instanceOf(refused, OperationEndedError)
          assert.deepStrictEqual(log, ["first"])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "leaves the work of a Hearth whose heartbeat goes on, and takes it once it stops",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const other = "00000000-0000-4000-8000-0000000000ee"
          const now = Date.now()
          yield* insertRows("operation_driver", {
            heartbeat_at: now,
            id: other,
            started_at: now,
          })
          yield* insertRows("operation", {
            admitted_at: now,
            driver: other,
            durable: false,
            id: "00000000-0000-4000-8000-000000000002",
            input_hash: "0".repeat(64),
            kind: "test.write",
            sequence: 1,
            state: "running",
            updated_at: now,
            version: 1,
          })
          yield* insertRows("operation_lock", {
            held: true,
            lock_key: "server-a",
            mode: "exclusive",
            operation_id: "00000000-0000-4000-8000-000000000002",
          })
          yield* insertRows("operation_scheduler", { id: 1, next_sequence: 2 })

          yield* recoverOperations()
          assert.deepStrictEqual(yield* states, ["test.write:running"])

          // Its heartbeat stops, longer ago than a running change is given.
          yield* SqlClient.SqlClient.pipe(
            Effect.flatMap((sql) =>
              sql.unsafe(
                `UPDATE ${databaseTable("operation_driver")}
                    SET heartbeat_at = ? WHERE id = ?`,
                [now - 180_000, other]
              )
            )
          )
          yield* recoverOperations()
          assert.deepStrictEqual(yield* states, ["test.write:interrupted"])
          assert.deepStrictEqual(yield* selectRows("operation_lock"), [])
        }).pipe(TestClock.withLive)
    )
  })
})
