import { Effect, Schema } from "effect"
import { Activity, Workflow } from "effect/workflow"

/** A move in three steps, for exercising the engine across a crash. */
export const Move = Workflow.make("Operations.test.move", {
  idempotencyKey: ({ id }) => id,
  payload: { id: Schema.String },
  success: Schema.String,
})

export interface MoveHooks {
  /** Runs as a step does its work; returns how often it has run here. */
  readonly step: (name: string) => Effect.Effect<number>
  /** The copy step finishes once this does. */
  readonly copied: Effect.Effect<void>
}

export const moveHandler = (hooks: MoveHooks) =>
  Move.toLayer(
    Effect.fnUntraced(function* () {
      const prepared = yield* Activity.make({
        name: "prepare",
        success: Schema.Number,
        execute: hooks.step("prepare"),
      })
      const copied = yield* Activity.make({
        name: "copy",
        success: Schema.Number,
        execute: hooks.step("copy").pipe(Effect.tap(() => hooks.copied)),
      })
      const handedOver = yield* Activity.make({
        name: "handOver",
        success: Schema.Number,
        execute: hooks.step("handOver"),
      })
      return `${prepared}-${copied}-${handedOver}`
    })
  )
