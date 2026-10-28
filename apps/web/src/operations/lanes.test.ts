import { assert, layer } from "@effect/vitest"
import { exclusive } from "@workspace/operations"
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { Database } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

import { durableOperation, startDurableOperation } from "./durable"
import { operationsTablePrefix } from "./engine"
import {
  OperationConflictError,
  OperationEndedError,
  forgetFinishedOperations,
  hearthDriverId,
  loadOperation,
  recoverOperations,
  retireDriver,
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
          // Admitted by this Hearth as it starts, before it recovers.
          const waiting = yield* hold(log, "server-a", "after restart")
          yield* states.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("20 millis"),
              until: (found) => found.includes("test.write:waiting"),
            })
          )

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
      "frees a change's locks once MySQL answers, when it couldn't as the change ended",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const database = yield* Database
          // MySQL refuses the first try to end it, then is back.
          let refusals = 1
          const flaky = Database.of({
            ...database,
            transaction: (operation, run) =>
              operation === "operations.finish" && refusals-- > 0
                ? Effect.fail(new DatabaseError({ cause: "gone", operation }))
                : database.transaction(operation, run),
          })
          const log: Array<string> = []
          yield* runOperation(
            write,
            { key: "server-a", name: "first" },
            Effect.sync(() => log.push("first"))
          ).pipe(Effect.provideService(Database, flaky))

          // What waits behind it runs, without a restart.
          yield* runOperation(
            write,
            { key: "server-a", name: "second" },
            Effect.sync(() => log.push("second"))
          ).pipe(Effect.timeout("20 seconds"))

          assert.deepStrictEqual(log, ["first", "second"])
          assert.deepStrictEqual(yield* states, [
            "test.write:succeeded",
            "test.write:succeeded",
          ])
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "ends a change whose admission went through though its answer was lost",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const database = yield* Database
          const lossy = Database.of({
            ...database,
            transaction: (operation, run) =>
              operation === "operations.admit"
                ? database
                    .transaction(operation, run)
                    .pipe(
                      Effect.andThen(
                        Effect.fail(
                          new DatabaseError({ cause: "lost", operation })
                        )
                      )
                    )
                : database.transaction(operation, run),
          })
          const ran = yield* runOperation(
            write,
            { key: "server-a", name: "lost" },
            Effect.void
          ).pipe(Effect.provideService(Database, lossy), Effect.flip)

          assert.instanceOf(ran, DatabaseError)
          assert.deepStrictEqual(yield* states, ["test.write:cancelled"])
          assert.deepStrictEqual(yield* selectRows("operation_lock"), [])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "doesn't run a change taken from it between its grant and its start",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const database = yield* Database
          // Another Hearth takes it over just as it starts.
          const takenOver = Database.of({
            ...database,
            execute: (operation, statement, values) =>
              operation === "operations.start"
                ? database
                    .execute(
                      "test.takeOver",
                      `UPDATE ${databaseTable("operation")}
                          SET state = 'interrupted'`
                    )
                    .pipe(
                      Effect.andThen(
                        database.execute(operation, statement, values)
                      )
                    )
                : database.execute(operation, statement, values),
          })
          const log: Array<string> = []
          const refused = yield* runOperation(
            write,
            { key: "server-a", name: "late" },
            Effect.sync(() => log.push("late"))
          ).pipe(Effect.provideService(Database, takenOver), Effect.flip)

          assert.instanceOf(refused, OperationEndedError)
          assert.deepStrictEqual(log, [])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "stays known as running when it stops mid-change, until that change ends",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const drivers = selectRows<{ id: string }>("operation_driver").pipe(
            Effect.map((rows) => rows.map((row) => row.id))
          )
          const release = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const change = yield* runOperation(
            write,
            { key: "server-a", name: "mid-change" },
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ).pipe(Effect.forkChild)
          yield* Deferred.await(started)

          // Hearth stops while the change runs: another Hearth must still
          // see it as running, and leave the change its locks.
          yield* retireDriver()
          assert.deepStrictEqual(yield* drivers, [hearthDriverId])

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(change)
          yield* retireDriver()
          assert.deepStrictEqual(yield* drivers, [])
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "keeps a waiting change its own Hearth's when another Hearth's grants it",
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
          // This Hearth holds server-a; the other Hearth's change waits.
          const release = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const holding = yield* runOperation(
            write,
            { key: "server-a", name: "holder" },
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* insertRows("operation", {
            admitted_at: now,
            driver: other,
            durable: false,
            id: "00000000-0000-4000-8000-000000000003",
            input_hash: "0".repeat(64),
            kind: "test.write",
            sequence: 99,
            state: "waiting",
            updated_at: now,
            version: 1,
          })
          yield* insertRows("operation_lock", {
            held: false,
            lock_key: "server-a",
            mode: "exclusive",
            operation_id: "00000000-0000-4000-8000-000000000003",
          })

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holding)

          const waiting = (yield* selectRows<{
            driver: string
            id: string
            state: string
          }>("operation")).find(
            (row) => row.id === "00000000-0000-4000-8000-000000000003"
          )
          assert.strictEqual(waiting?.state, "granted")
          assert.strictEqual(waiting?.driver, other)
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

    it.effect(
      "finishes a running change whose caller gave up, before freeing its locks",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const log: Array<string> = []
          const change = yield* hold(log, "server-a", "change")
          yield* until(() => log.includes("change"))

          const givingUp = yield* Fiber.interrupt(change.fiber).pipe(
            Effect.forkChild
          )
          const next = yield* hold(log, "server-a", "next")
          yield* Effect.sleep("100 millis")
          assert.deepStrictEqual(log, ["change"], "the change still holds")
          yield* Deferred.succeed(change.release, undefined)
          yield* Fiber.join(givingUp)
          yield* until(() => log.includes("next"))
          yield* Deferred.succeed(next.release, undefined)
          yield* Fiber.join(next.fiber)

          assert.deepStrictEqual(yield* states, [
            "test.write:succeeded",
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

          // Past its retention it's forgotten, with its workflow's history.
          const sql = yield* SqlClient.SqlClient
          const history = sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM ${sql(`${operationsTablePrefix()}_messages`)}
             WHERE entity_id = ${done?.executionId ?? ""}`
          assert.isAbove((yield* history)[0].count, 0)
          yield* Effect.sleep("5 millis")
          assert.isAbove(yield* forgetFinishedOperations("0 millis"), 0)
          assert.strictEqual(yield* loadOperation(id), null)
          assert.strictEqual((yield* history)[0].count, 0)
        }).pipe(TestClock.withLive)
    )
  })
})
