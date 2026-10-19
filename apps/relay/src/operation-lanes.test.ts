import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"

import {
  exclusive,
  LaneRejectedError,
  OperationLanes,
  shared,
  type LaneLock,
} from "./operation-lanes.js"

/**
 * Starts an operation that records when it begins and holds its locks until
 * released, so tests can observe what runs together.
 */
const start = Effect.fnUntraced(function* (
  lanes: OperationLanes,
  log: Array<string>,
  label: string,
  locks: ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>>,
  options: { readonly precondition?: () => boolean } = {}
) {
  const release = yield* Deferred.make<void>()
  const fiber = yield* lanes
    .run(
      { label, locks, ...options },
      Effect.sync(() => log.push(label)).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(label)
      )
    )
    .pipe(Effect.forkChild({ startImmediately: true }))
  yield* Effect.yieldNow
  return {
    fiber,
    finish: Deferred.succeed(release, undefined).pipe(
      Effect.andThen(Effect.yieldNow)
    ),
  }
})

describe("operation lanes", () => {
  it.effect("runs conflicting operations in the order they arrived", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const first = yield* start(lanes, log, "first", [exclusive("a")])
      const second = yield* start(lanes, log, "second", [exclusive("a")])
      const third = yield* start(lanes, log, "third", [exclusive("a")])
      assert.deepStrictEqual(log, ["first"])

      yield* first.finish
      assert.deepStrictEqual(log, ["first", "second"])
      yield* second.finish
      yield* third.finish
      assert.deepStrictEqual(log, ["first", "second", "third"])
      assert.strictEqual(yield* Fiber.join(third.fiber), "third")
    })
  )

  it.effect("runs operations on different resources at once", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      yield* start(lanes, log, "a", [exclusive("a")])
      yield* start(lanes, log, "b", [exclusive("b")])
      yield* start(lanes, log, "a-reader", [shared("c")])
      yield* start(lanes, log, "c-reader", [shared("c")])
      assert.deepStrictEqual(log, ["a", "b", "a-reader", "c-reader"])
    })
  )

  it.effect(
    "keeps later shared work behind a waiting exclusive operation",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const log: Array<string> = []
        const reader = yield* start(lanes, log, "reader", [shared("a")])
        const writer = yield* start(lanes, log, "writer", [exclusive("a")])
        yield* start(lanes, log, "late-reader", [shared("a")])
        // The writer waits for the reader, and the late reader waits for the
        // writer instead of overtaking it.
        assert.deepStrictEqual(log, ["reader"])
        yield* reader.finish
        assert.deepStrictEqual(log, ["reader", "writer"])
        yield* writer.finish
        assert.deepStrictEqual(log, ["reader", "writer", "late-reader"])
      })
  )

  it.effect("grants all of an operation's locks together", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const holdsA = yield* start(lanes, log, "holds-a", [exclusive("a")])
      // Needs both; B is free but A isn't, so it takes neither yet.
      yield* start(lanes, log, "needs-a-and-b", [
        exclusive("a"),
        exclusive("b"),
      ])
      // Wants B after the operation above, so it waits its turn.
      yield* start(lanes, log, "needs-b", [exclusive("b")])
      // Unrelated work still runs.
      yield* start(lanes, log, "needs-c", [exclusive("c")])
      assert.deepStrictEqual(log, ["holds-a", "needs-c"])
      yield* holdsA.finish
      assert.deepStrictEqual(log, ["holds-a", "needs-c", "needs-a-and-b"])
    })
  )

  it.effect("holds back later work until an earlier lookup settles", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      let settle: (locks: ReadonlyArray<LaneLock>) => void = () => undefined
      const lookup = new Promise<ReadonlyArray<LaneLock>>((resolve) => {
        settle = resolve
      })
      yield* start(lanes, log, "aliased", lookup)
      yield* start(lanes, log, "later", [exclusive("b")])
      assert.deepStrictEqual(log, [])

      settle([exclusive("a")])
      yield* Effect.promise(() => lookup)
      yield* Effect.yieldNow
      assert.deepStrictEqual(log, ["aliased", "later"])
    })
  )

  it.effect(
    "lets the next operation start when a waiting one is withdrawn",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const log: Array<string> = []
        const first = yield* start(lanes, log, "first", [exclusive("a")])
        const withdrawn = lanes.admit({
          label: "withdrawn",
          locks: [exclusive("a"), exclusive("b")],
        })
        yield* start(lanes, log, "needs-b", [exclusive("b")])
        assert.deepStrictEqual(log, ["first"])

        withdrawn.cancel()
        yield* Effect.yieldNow
        assert.deepStrictEqual(log, ["first", "needs-b"])
        const result = yield* Effect.exit(withdrawn.run(Effect.void))
        assert.isTrue(Exit.isFailure(result))
        yield* first.finish
      })
  )

  it.effect("keeps a started operation's locks after its caller gives up", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const started = yield* start(lanes, log, "started", [exclusive("a")])
      const next = yield* start(lanes, log, "next", [exclusive("a")])

      yield* Fiber.interrupt(started.fiber)
      assert.deepStrictEqual(log, ["started"])
      yield* started.finish
      assert.deepStrictEqual(log, ["started", "next"])
      yield* next.finish
    })
  )

  it.effect("withdraws an operation whose caller gives up while it waits", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const first = yield* start(lanes, log, "first", [exclusive("a")])
      const abandoned = yield* start(lanes, log, "abandoned", [exclusive("a")])
      const last = yield* start(lanes, log, "last", [exclusive("a")])

      yield* Fiber.interrupt(abandoned.fiber)
      yield* first.finish
      assert.deepStrictEqual(log, ["first", "last"])
      yield* last.finish
    })
  )

  it.effect("checks a precondition after the work ahead of it has run", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      let generation = 0
      const manual = yield* start(lanes, log, "manual-stop", [exclusive("a")])
      const scheduled = yield* start(
        lanes,
        log,
        "scheduled-start",
        [exclusive("a")],
        { precondition: () => generation === 0 }
      )
      generation += 1
      yield* manual.finish

      const result = yield* Effect.flip(Fiber.join(scheduled.fiber))
      assert.instanceOf(result, LaneRejectedError)
      assert.strictEqual((result as LaneRejectedError).reason, "superseded")
      assert.deepStrictEqual(log, ["manual-stop"])
    })
  )

  it.effect("lets a running operation take more locks ahead of the line", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const routeWriter = yield* start(lanes, log, "other-routes", [
        shared("routes"),
      ])
      const deletion = yield* Deferred.make<void>()
      const deleteFiber = yield* lanes
        .run(
          { label: "delete", locks: [exclusive("server")] },
          Effect.gen(function* () {
            log.push("delete")
            yield* Deferred.await(deletion)
            // Clears its routes once the server is gone.
            yield* lanes.runNested(
              { label: "delete.routes", locks: [exclusive("routes")] },
              Effect.sync(() => log.push("delete.routes"))
            )
          })
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      // Waits on both the server the delete holds and the routes.
      yield* start(lanes, log, "route-write", [
        exclusive("routes"),
        exclusive("server"),
      ])

      yield* Deferred.succeed(deletion, undefined)
      yield* Effect.yieldNow
      // The nested lock waits only for the current holder, not the route
      // write queued ahead of it, which is itself waiting on the delete.
      assert.deepStrictEqual(log, ["other-routes", "delete"])
      yield* routeWriter.finish
      yield* Fiber.join(deleteFiber)
      assert.deepStrictEqual(log, [
        "other-routes",
        "delete",
        "delete.routes",
        "route-write",
      ])
    })
  )

  it.effect("counts an exclusive operation only once it starts", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      // Granted at once, then refused before it ran, as a request that
      // fails its permission check is.
      const refused = lanes.admit({ label: "delete", locks: [exclusive("a")] })
      refused.cancel()
      assert.strictEqual(lanes.exclusiveGeneration("a"), 0)

      yield* lanes.run({ label: "restore", locks: [exclusive("a")] }, Effect.void)
      assert.strictEqual(lanes.exclusiveGeneration("a"), 1)
    })
  )

  it.effect("refuses new work past its waiting limit", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes({ maxWaiting: 1 })
      const log: Array<string> = []
      yield* start(lanes, log, "running", [exclusive("a")])
      yield* start(lanes, log, "waiting", [exclusive("a")])
      const refused = yield* Effect.flip(
        lanes.run({ label: "refused", locks: [exclusive("b")] }, Effect.void)
      )
      assert.strictEqual((refused as LaneRejectedError).reason, "busy")
    })
  )
})
