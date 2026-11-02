import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"

import {
  LaneRejectedError,
  OperationLanes,
  type LaneAdmission,
} from "./lanes.js"
import { exclusive, shared, type LaneLock } from "./locks.js"

/**
 * Starts an operation that records when it begins and holds its locks until
 * released, so tests can observe what runs together.
 */
const start = Effect.fnUntraced(function* (
  lanes: OperationLanes,
  log: Array<string>,
  label: string,
  locks: ReadonlyArray<LaneLock>,
  admission: Omit<LaneAdmission, "label" | "locks"> = {}
) {
  const release = yield* Deferred.make<void>()
  const fiber = yield* lanes
    .run(
      { ...admission, label, locks },
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
  it.effect("withdraws only what hasn't started, and says which", () =>
    Effect.gen(function* () {
      const lanes = new OperationLanes()
      const log: Array<string> = []
      const holder = yield* start(lanes, log, "holder", [exclusive("a")])
      const record = (label: string) => Effect.sync(() => log.push(label))

      // Waiting its turn: withdrawn, and never runs.
      const waiting = lanes.admit({ label: "waiting", locks: [exclusive("a")] })
      const waitingRun = yield* waiting
        .run(record("waiting"))
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
      assert.isTrue(waiting.withdraw())
      assert.strictEqual((yield* Fiber.join(waitingRun)).reason, "cancelled")

      // Given its turn but not yet started: withdrawn all the same.
      const granted = lanes.admit({ label: "granted", locks: [exclusive("a")] })
      yield* holder.finish
      assert.isTrue(granted.withdraw())
      const grantedRun = yield* granted.run(record("granted")).pipe(Effect.flip)
      assert.strictEqual(grantedRun._tag, "LaneRejectedError")

      // Started: not withdrawn, and it runs to the end.
      const release = yield* Deferred.make<void>()
      const running = lanes.admit({ label: "running", locks: [exclusive("a")] })
      const runningRun = yield* running
        .run(
          record("running").pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("finished")
          )
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      assert.isFalse(running.withdraw())
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual(yield* Fiber.join(runningRun), "finished")
      assert.deepStrictEqual(log, ["holder", "running"])
    })
  )

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

  it.effect(
    "carries upkeep on through a pause, still in its turn and still refused",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes({
          refuse: (label) => (label === "fenced" ? "It's fenced" : null),
        })
        const log: Array<string> = []
        const upkeep = { carriesOnWhilePaused: true }
        const holder = yield* start(lanes, log, "holder", [exclusive("a")])
        const queued = yield* start(lanes, log, "queued", [exclusive("a")])
        const before = yield* start(
          lanes,
          log,
          "upkeep-before",
          [exclusive("a")],
          upkeep
        )
        lanes.setPaused(true)

        // Ordinary work is withdrawn and refused; upkeep keeps its place,
        // and more joins the line behind it.
        const withdrawn = yield* Effect.flip(Fiber.join(queued.fiber))
        assert.strictEqual((withdrawn as LaneRejectedError).reason, "paused")
        const refused = yield* lanes
          .run({ label: "change", locks: [exclusive("b")] }, Effect.void)
          .pipe(Effect.flip)
        assert.strictEqual(refused.reason, "paused")
        const after = yield* start(
          lanes,
          log,
          "upkeep-after",
          [exclusive("a")],
          upkeep
        )
        const fenced = yield* lanes
          .run(
            { ...upkeep, label: "fenced", locks: [exclusive("c")] },
            Effect.void
          )
          .pipe(Effect.flip)
        assert.strictEqual(fenced.reason, "refused")

        // Neither overtakes the holder, nor each other.
        assert.deepStrictEqual(log, ["holder"])
        yield* holder.finish
        assert.deepStrictEqual(log, ["holder", "upkeep-before"])
        yield* before.finish
        assert.deepStrictEqual(log, ["holder", "upkeep-before", "upkeep-after"])
        yield* after.finish
        assert.strictEqual(yield* Fiber.join(after.fiber), "upkeep-after")
      })
  )
})
