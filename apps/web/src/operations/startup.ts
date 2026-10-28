import { Effect, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"

import { dispatchDurableOperations } from "./durable"
import { OperationsEngineService } from "./engine-service"
import {
  forgetFinishedOperations,
  recoverOperations,
  undispatchedOperations,
} from "./lanes"

// Finished operations are kept this long, for their timings and for Relay
// commands whose outcomes might still be checked against them.
const RETENTION = "30 days"

// A durable operation is started when it's granted; one whose start failed,
// as while MySQL or the engine was away, is started by this sweep.
const DISPATCH_SWEEP = "15 seconds"

/**
 * Starts the operations engine with Hearth, so work a previous Hearth left
 * unfinished resumes without waiting for a request to need the engine:
 * operations that ended with the old Hearth free their locks, and durable
 * ones granted but never started start. Tries again while MySQL isn't
 * reachable yet, then keeps starting granted work and forgetting finished
 * operations past their retention.
 */
export function startOperationsEngine(): void {
  forkAppWorker(
    Effect.gen(function* () {
      const { engine } = yield* OperationsEngineService
      yield* engine
      yield* recoverOperations()
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Operations engine not started yet", error)
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.andThen(
        Effect.all(
          [
            undispatchedOperations().pipe(
              Effect.flatMap(dispatchDurableOperations),
              Effect.ignore,
              Effect.repeat(Schedule.spaced(DISPATCH_SWEEP))
            ),
            forgetFinishedOperations(RETENTION).pipe(
              Effect.ignore,
              Effect.repeat(Schedule.spaced("1 hour"))
            ),
          ],
          { concurrency: "unbounded", discard: true }
        )
      ),
      Effect.ignore
    )
  )
}
