import { Effect, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"

import { dispatchDurableOperations } from "./durable"
import { OperationsEngineService } from "./engine-service"
import { forgetFinishedOperations, recoverOperations } from "./lanes"

// Finished operations are kept this long, for their timings and for Relay
// commands whose outcomes might still be checked against them.
const RETENTION = "30 days"

/**
 * Starts the operations engine with Hearth, so work a previous Hearth left
 * unfinished resumes without waiting for a request to need the engine:
 * operations that ended with the old Hearth free their locks, and durable
 * ones granted but never started start now. Tries again while MySQL isn't
 * reachable yet, then keeps finished operations to their retention.
 */
export function startOperationsEngine(): void {
  forkAppWorker(
    Effect.gen(function* () {
      const { engine } = yield* OperationsEngineService
      yield* engine
      yield* dispatchDurableOperations(yield* recoverOperations())
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Operations engine not started yet", error)
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.andThen(
        forgetFinishedOperations(RETENTION).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced("1 hour"))
        )
      ),
      Effect.ignore
    )
  )
}
