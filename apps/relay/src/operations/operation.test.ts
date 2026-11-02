import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"

import {
  exclusive,
  laneKeys,
  LaneRejectedError,
  OperationLanes,
  shared,
} from "../operation-lanes.js"
import { operation, runOperation } from "./operation.js"

const serverId = "a".repeat(40)
const timer = { kind: "timer" } as const

describe("Relay operations", () => {
  it.effect(
    "runs work inside an operation under its locks, without waiting on it",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const inner = operation<void>()({
          name: "test.inner",
          locks: () => [exclusive(laneKeys.instanceLifecycle(serverId))],
          run: () => Effect.succeed("inner ran"),
        })
        const outer = operation<void>()({
          name: "test.outer",
          locks: () => [exclusive(laneKeys.instance(serverId))],
          run: () => runOperation(lanes, inner, undefined, timer),
        })

        expect(yield* runOperation(lanes, outer, undefined, timer)).toBe(
          "inner ran"
        )
      })
  )

  it.effect(
    "dies naming what an operation inside another needs that it doesn't hold",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const inner = operation<void>()({
          name: "test.inner",
          locks: () => [exclusive(laneKeys.routes)],
          run: () => Effect.void,
        })
        const outer = operation<void>()({
          name: "test.outer",
          locks: () => [shared(laneKeys.instance(serverId))],
          run: () => runOperation(lanes, inner, undefined, timer),
        })

        const exit = yield* Effect.exit(
          runOperation(lanes, outer, undefined, timer)
        )
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "test.inner needs relay:routes, which test.outer doesn't hold"
        )
      })
  )

  it.effect(
    "ends work overruled while it waited as superseded, without running it",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        let wanted = "start"
        let ran = false
        const holding = yield* Deferred.make<void>()
        const before = yield* Effect.forkChild(
          lanes.run(
            {
              label: "instance.action",
              locks: [exclusive(laneKeys.instanceLifecycle(serverId))],
            },
            Deferred.await(holding)
          )
        )
        const start = operation<void>()({
          name: "test.start",
          locks: () => [exclusive(laneKeys.instanceLifecycle(serverId))],
          precondition: () => wanted === "start",
          run: () =>
            Effect.sync(() => {
              ran = true
            }),
        })
        const waiting = yield* Effect.forkChild(
          runOperation(lanes, start, undefined, timer)
        )
        yield* Effect.yieldNow
        wanted = "stop"
        yield* Deferred.succeed(holding, undefined)
        yield* Fiber.join(before)

        const exit = yield* Fiber.await(waiting)
        expect(ran).toBe(false)
        expect(
          Exit.isFailure(exit) && Exit.findErrorOption(exit)
        ).toMatchObject({
          value: { reason: "superseded" },
        })
      })
  )

  it.effect(
    "turns away work only worth doing now when something is in its way",
    () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const holding = yield* Deferred.make<void>()
        const change = yield* Effect.forkChild(
          lanes.run(
            {
              label: "instance.routes.write",
              locks: [exclusive(laneKeys.routes)],
            },
            Deferred.await(holding)
          )
        )
        yield* Effect.yieldNow
        const upkeep = operation<void>()({
          name: "test.upkeep",
          locks: () => [exclusive(laneKeys.routes)],
          onlyIfFree: true,
          run: () => Effect.void,
        })

        const refused = yield* Effect.flip(
          runOperation(lanes, upkeep, undefined, timer)
        )
        expect(refused).toBeInstanceOf(LaneRejectedError)
        expect(refused).toMatchObject({ reason: "busy" })
        yield* Deferred.succeed(holding, undefined)
        yield* Fiber.join(change)
      })
  )
})
