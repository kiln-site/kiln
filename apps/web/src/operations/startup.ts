import { Cause, Duration, Effect, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"

import { dispatchDurableOperations } from "./durable"
import { OperationsEngineService } from "./engine-service"
import {
  DRIVER_HEARTBEAT,
  forgetFinishedOperations,
  heartbeatDriver,
  recoverOperations,
  retireDriver,
  undispatchedOperations,
} from "./lanes"

// Finished operations are kept this long, for their timings and for Relay
// commands whose outcomes might still be checked against them.
const RETENTION = "30 days"

// Every so often, the work of a Hearth whose heartbeat stopped is taken
// over, and a durable operation granted but not started, as one whose start
// failed while MySQL or the engine was away, is started.
const SWEEP = "15 seconds"

// Runs `effect` every `interval` for as long as Hearth runs, whatever one
// run does short of Hearth stopping, so one failure, even a defect such as
// the engine failing to build, stops none of the others.
const untraced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.withTracerEnabled(effect, false)

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
 * unfinished resumes without waiting for a request to need the engine. Each
 * part runs on its own: this Hearth's heartbeat and taking over a stopped
 * Hearth's work need only MySQL, so they go on while the engine can't start;
 * starting granted durable work tries the engine again each time; finished
 * operations are forgotten past their retention. Stopping, it says so, so
 * the next Hearth needn't wait.
 */
export function startOperationsEngine(): void {
  forkAppWorker(
    Effect.all(
      [
        // Checks that find nothing to do leave no trace; work they find
        // does, and recovery logs what it took over.
        every(
          DRIVER_HEARTBEAT,
          "Operations heartbeat failed",
          untraced(heartbeatDriver())
        ),
        every(
          SWEEP,
          "Operations recovery failed",
          untraced(recoverOperations())
        ),
        every(
          SWEEP,
          "Operations engine not started yet",
          Effect.gen(function* () {
            const { engine } = yield* OperationsEngineService
            // Traced: workflows built with it keep the context it's built in.
            yield* engine
            const granted = yield* untraced(undispatchedOperations())
            if (granted.length > 0) yield* dispatchDurableOperations(granted)
          })
        ),
        every(
          "1 hour",
          "Operations retention failed",
          forgetFinishedOperations(RETENTION)
        ),
      ],
      { concurrency: "unbounded", discard: true }
    ).pipe(Effect.ensuring(retireDriver().pipe(Effect.ignore)), Effect.ignore)
  )
}
