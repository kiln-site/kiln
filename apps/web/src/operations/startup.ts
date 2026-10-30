import { Cause, Duration, Effect, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"

import { dispatchDurableOperations } from "./durable"
import { OperationsEngineService } from "./engine-service"
import { forgetFinishedOperations, undispatchedOperations } from "./records"

// Finished operations are kept this long, for their timings and for Relay
// commands whose outcomes might still be checked against them.
const RETENTION = "30 days"

// Every so often, a durable operation recorded but whose workflow didn't
// start, as when Hearth stopped between the two or the engine was away, is
// started. Workflows that started resume with the engine.
const SWEEP = "1 minute"

// Runs `effect` every `interval` for as long as Hearth runs, whatever one
// run does short of Hearth stopping, so one failure, even a defect such as
// the engine failing to build, stops none of the others.
const every = <E, R>(
  interval: Duration.Input,
  label: string,
  effect: Effect.Effect<unknown, E, R>
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(label, cause)
    ),
    Effect.repeat(Schedule.spaced(interval))
  )

/**
 * Starts the operations engine with Hearth, so work a previous Hearth left
 * unfinished resumes without waiting for a request to need the engine, and
 * forgets finished operations past their retention.
 */
export function startOperationsEngine(): void {
  forkAppWorker(
    Effect.all(
      [
        every(
          SWEEP,
          "Operations engine not started yet",
          Effect.gen(function* () {
            const { engine } = yield* OperationsEngineService
            // Traced: workflows built with it keep the context it's built in.
            yield* engine
            // A sweep that finds nothing to do leaves no trace.
            const undispatched = yield* Effect.withTracerEnabled(
              undispatchedOperations(),
              false
            )
            if (undispatched.length > 0) {
              yield* dispatchDurableOperations(undispatched)
            }
          })
        ),
        every(
          "1 hour",
          "Operations retention failed",
          forgetFinishedOperations(RETENTION)
        ),
      ],
      { concurrency: "unbounded", discard: true }
    ).pipe(Effect.ignore)
  )
}
