import { Effect } from "effect"
import { afterAll, expect, it } from "vite-plus/test"

import { isExpectedAppError } from "@/observability/error-policy"

import { disposeAppRuntime, runAppEffect } from "./runtime"

afterAll(() => disposeAppRuntime())

it("treats work stopped because its request was abandoned as an abort", async () => {
  const request = new AbortController()
  const running = runAppEffect("Test.abandoned", Effect.never, {
    signal: request.signal,
  })
  request.abort()

  const error = await running.then(
    () => null,
    (cause: unknown) => cause
  )
  expect(error).toMatchObject({ name: "AbortError" })
  expect(isExpectedAppError(error)).toBe(true)
})

it("still reports what failed in a request that was abandoned", async () => {
  const request = new AbortController()
  request.abort()
  const failure = new Error("The database went away")

  const error = await runAppEffect(
    "Test.failedAfterAbort",
    Effect.uninterruptible(Effect.fail(failure)),
    { signal: request.signal }
  ).then(
    () => null,
    (cause: unknown) => cause
  )
  expect(error).toBe(failure)
  expect(isExpectedAppError(error)).toBe(false)
})
