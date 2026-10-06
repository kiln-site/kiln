import { it as effectIt } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vite-plus/test"

import { RelaySystemUpdateError } from "./effect/errors.js"
import {
  drainUpdateBatchEffect,
  retryContainerReplacementEffect,
} from "./updater-effects.js"

function replacementFailure(rollbackFailures: ReadonlyArray<string>) {
  return RelaySystemUpdateError.make({
    phase: "replace",
    reason: "Replacement failed",
    rollbackFailures,
  })
}

describe("updater batch draining", () => {
  effectIt.effect("processes a batch joined during the final idle wait", () =>
    Effect.gen(function* () {
      let pendingBatches = 0
      let processedBatches = 0
      const drain = yield* drainUpdateBatchEffect(() =>
        Effect.sync(() => {
          if (pendingBatches === 0) return false
          pendingBatches -= 1
          processedBatches += 1
          return true
        })
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust("2500 millis")
      pendingBatches += 1
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(drain)

      expect(processedBatches).toBe(1)
    })
  )
})

describe("container replacement retries", () => {
  effectIt.effect("keeps the bounded three-attempt retry policy", () =>
    Effect.gen(function* () {
      let attempts = 0
      const failure = replacementFailure([])
      const fiber = yield* retryContainerReplacementEffect(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(failure)
        })
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust("3 seconds")
      const result = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect(result).toBe(failure)
      expect(attempts).toBe(3)
    })
  )

  effectIt.effect("does not retry after rollback failure", () =>
    Effect.gen(function* () {
      let attempts = 0
      const failure = replacementFailure(["Could not restore backup"])

      const result = yield* retryContainerReplacementEffect(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(failure)
        })
      ).pipe(Effect.flip)

      expect(result).toBe(failure)
      expect(attempts).toBe(1)
    })
  )
})
