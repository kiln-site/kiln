import { Effect, Schedule } from "effect"

import { RelaySystemUpdateError } from "./effect/errors.js"

const batchJoinWait = "2500 millis"

export const drainUpdateBatchEffect = Effect.fn("relay.updater.drainBatch")(
  function* (
    processPending: () => Effect.Effect<boolean, RelaySystemUpdateError>
  ) {
    let idleChecks = 0
    while (true) {
      const processed = yield* processPending()
      if (processed) {
        idleChecks = 0
        continue
      }
      if (idleChecks >= 2) return
      idleChecks += 1
      yield* Effect.sleep(batchJoinWait)
    }
  }
)

export function retryContainerReplacementEffect<A, R>(
  replacement: Effect.Effect<A, RelaySystemUpdateError, R>
) {
  return replacement.pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: 2,
      while: (failure) => failure.rollbackFailures.length === 0,
    })
  )
}
