import { Effect, Schedule } from "effect"

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

/**
 * Starts the operations engine with Hearth, so work a previous Hearth left
 * unfinished resumes without waiting for a request to need the engine. Tries
 * again while MySQL isn't reachable yet. Then it keeps this Hearth's
 * heartbeat, takes over the work of one whose heartbeat stopped, starts
 * granted durable work, and forgets finished operations past their
 * retention. Stopping, it says so, so the next Hearth needn't wait.
 */
export function startOperationsEngine(): void {
  // The heartbeat needs only MySQL: requests' quick operations run before
  // the engine is up, and must stay this Hearth's meanwhile.
  const heartbeat = heartbeatDriver().pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced(DRIVER_HEARTBEAT))
  )
  const engine = Effect.gen(function* () {
    const { engine } = yield* OperationsEngineService
    yield* engine
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Operations engine not started yet", error)
    ),
    Effect.retry(Schedule.spaced("5 seconds")),
    Effect.andThen(
      Effect.all(
        [
          recoverOperations().pipe(
            Effect.ignore,
            Effect.andThen(undispatchedOperations()),
            Effect.flatMap(dispatchDurableOperations),
            Effect.ignore,
            Effect.repeat(Schedule.spaced(SWEEP))
          ),
          forgetFinishedOperations(RETENTION).pipe(
            Effect.ignore,
            Effect.repeat(Schedule.spaced("1 hour"))
          ),
        ],
        { concurrency: "unbounded", discard: true }
      )
    )
  )
  forkAppWorker(
    Effect.all([heartbeat, engine], {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ensuring(retireDriver().pipe(Effect.ignore)), Effect.ignore)
  )
}
