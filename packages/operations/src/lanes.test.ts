import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"

import { LaneRejectedError, OperationLanes } from "./lanes.js"
import { exclusive, shared, type LaneLock } from "./locks.js"

/**
 * Starts an operation that records when it begins and holds its locks until
 * released, so tests can observe what runs together.
 */
const start = Effect.fnUntraced(function* (
  lanes: OperationLanes,
  log: Array<string>,
  label: string,
  locks: ReadonlyArray<LaneLock>
) {
  const release = yield* Deferred.make<void>()
  const fiber = yield* lanes
    .run(
      { label, locks },
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
  it.effect(
    "refuses at once, naming what's in the way, an operation that would wait",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const log: Array<string> = []
        const holder = yield* start(lanes, log, "holder", [exclusive("a")])
        const queued = yield* start(lanes, log, "queued", [
          exclusive("b"),
          shared("a"),
        ])
        const refused = (locks: ReadonlyArray<LaneLock>) =>
          lanes
            .run({ label: "impatient", locks, whenBusy: "refuse" }, Effect.void)
            .pipe(Effect.flip)
        // Held, or wanted by one waiting ahead of it.
        const byHolder = yield* refused([shared("a")])
        const byQueue = yield* refused([exclusive("b")])
        assert.deepStrictEqual(
          [byHolder.reason, byHolder.blockedBy],
          ["busy", ["holder"]]
        )
        assert.deepStrictEqual(byQueue.blockedBy, ["queued"])
        // Nothing in its way: it runs, and it held no place in line.
        yield* lanes.run(
          { label: "free", locks: [exclusive("c")], whenBusy: "refuse" },
          Effect.sync(() => log.push("free"))
        )
        yield* holder.finish
        assert.deepStrictEqual(log, ["holder", "free", "queued"])
        yield* queued.finish
        assert.deepStrictEqual(yield* Fiber.join(queued.fiber), "queued")
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

  it.effect(
    "refuses work its turn comes for once refusal applies, but not nested work",
    () =>
      Effect.gen(function* () {
        const frozen = new Set<string>()
        const lanes = new OperationLanes({
          refuse: (label, locks) =>
            label !== "delete" && locks.some((lock) => frozen.has(lock.key))
              ? "It's being deleted"
              : null,
        })
        const log: Array<string> = []
        const freeze = yield* start(lanes, log, "freeze", [exclusive("a")])
        // Arrived before the freeze took hold, so it waits behind it.
        const queued = yield* start(lanes, log, "restart", [shared("a")])
        frozen.add("a")
        frozen.add("c")
        yield* freeze.finish

        const refused = yield* Effect.flip(Fiber.join(queued.fiber))
        assert.strictEqual((refused as LaneRejectedError).reason, "refused")
        assert.strictEqual(refused.message, "It's being deleted")
        const nested = yield* lanes.run(
          { label: "delete", locks: [exclusive("a")] },
          lanes.runNested(
            { label: "delete.volume", locks: [exclusive("c")] },
            Effect.sync(() => "nested ran")
          )
        )
        assert.strictEqual(nested, "nested ran")
        yield* lanes.run(
          { label: "other", locks: [exclusive("b")] },
          Effect.void
        )
        assert.deepStrictEqual(log, ["freeze"])
      })
  )
})
