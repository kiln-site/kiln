import { Effect, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"

import { OperationsEngineService } from "./engine-service"

/**
 * Starts the operations engine with Hearth, so work a previous Hearth left
 * unfinished resumes without waiting for a request to need the engine.
 * Tries again while MySQL isn't reachable yet.
 */
export function startOperationsEngine(): void {
  forkAppWorker(
    Effect.flatMap(OperationsEngineService, ({ engine }) => engine).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Operations engine not started yet", error)
      ),
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.asVoid,
      Effect.ignore
    )
  )
}
