import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { afterEach, vi } from "vite-plus/test"
import { z } from "zod"

import type { KilnSession } from "./config.js"
import {
  apiJsonEffect,
  apiResponseEffect,
  CLI_LONG_OPERATION_TIMEOUT_MS,
} from "./http.js"

const session: KilnSession = {
  profile: "test",
  token: "kiln_cli_test",
  url: "https://kiln.example.test",
}

describe("CLI HTTP requests", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.effect("combines caller cancellation with the operation deadline", () => {
    const caller = new AbortController()
    const addEventListener = vi.spyOn(caller.signal, "addEventListener")
    const removeEventListener = vi.spyOn(caller.signal, "removeEventListener")
    const scheduleTimeout = vi.spyOn(globalThis, "setTimeout")
    const cancelTimeout = vi.spyOn(globalThis, "clearTimeout")
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined
            if (requestSignal?.aborted) {
              reject(requestSignal.reason)
              return
            }
            requestSignal?.addEventListener(
              "abort",
              () => reject(requestSignal?.reason),
              { once: true }
            )
          })
      )
    )

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        apiResponseEffect(
          session,
          "/api/cli/v1/power",
          {
            signal: caller.signal,
            timeoutMs: CLI_LONG_OPERATION_TIMEOUT_MS,
          },
          (response) => Effect.succeed(response)
        ).pipe(Effect.exit)
      )
      yield* Effect.yieldNow

      assert.notStrictEqual(requestSignal, caller.signal)
      assert.isTrue(
        scheduleTimeout.mock.calls.some(
          ([, delay]) => delay === CLI_LONG_OPERATION_TIMEOUT_MS
        )
      )
      caller.abort(new DOMException("caller stopped", "AbortError"))
      yield* Fiber.join(fiber)

      assert.isTrue(requestSignal?.aborted ?? false)
      assert.isAbove(addEventListener.mock.calls.length, 0)
      assert.isAbove(removeEventListener.mock.calls.length, 0)
      assert.isAbove(cancelTimeout.mock.calls.length, 0)
    })
  })

  it.effect("aborts fetch when the Effect is interrupted", () => {
    let requestSignal: AbortSignal | undefined

    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (_input: RequestInfo | URL, init?: RequestInit) =>
            await new Promise<Response>((_resolve, reject) => {
              requestSignal = init?.signal ?? undefined
              Effect.runFork(Deferred.succeed(started, undefined))
              requestSignal?.addEventListener(
                "abort",
                () => reject(requestSignal?.reason),
                { once: true }
              )
            })
        )
      )
      const fiber = yield* Effect.forkChild(
        apiResponseEffect(
          session,
          "/api/cli/v1/logs",
          {
            timeoutMs: null,
          },
          (response) => Effect.succeed(response)
        )
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      assert.isTrue(requestSignal?.aborted ?? false)
    })
  })

  it.effect("keeps the deadline active while decoding a response body", () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined
        const body = new ReadableStream<Uint8Array>({
          start() {
            // Hold the headers open while the JSON body remains stalled.
          },
        })
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
        })
      })
    )

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        apiJsonEffect(
          session,
          "/api/cli/v1/stalled",
          z.object({ ok: z.boolean() })
        )
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      assert.isTrue(requestSignal?.aborted ?? false)
    })
  })

  it.effect("preserves structured Relay console failure details", () => {
    const requestId = "3df56ba5-b2c1-45ee-bab7-386fbb9223c7"
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                cause: "Survival is not running",
                code: "relay_operation_failed",
                message: "Relay could not send the console command.",
                requestId,
                retryable: false,
              },
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 502,
            }
          )
      )
    )

    return Effect.gen(function* () {
      const error = yield* apiJsonEffect(
        session,
        "/api/cli/v1/console",
        z.object({ accepted: z.boolean() })
      ).pipe(Effect.flip)

      assert.strictEqual(error.code, "relay_operation_failed")
      assert.strictEqual(
        error.message,
        "Relay could not send the console command."
      )
      assert.strictEqual(error.requestId, requestId)
      assert.instanceOf(error.cause, Error)
      assert.strictEqual(error.cause.message, "Survival is not running")
      assert.isFalse(error.retryable)
    })
  })

  it.effect(
    "identifies a 502 without Kiln error details as a proxy path",
    () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("Bad Gateway", {
              headers: { "Content-Type": "text/plain" },
              status: 502,
            })
        )
      )

      return Effect.gen(function* () {
        const error = yield* apiJsonEffect(
          session,
          "/api/cli/v1/console",
          z.object({ accepted: z.boolean() })
        ).pipe(Effect.flip)

        assert.strictEqual(error.code, "http_502")
        assert.strictEqual(error.message, "The request returned HTTP 502.")
        assert.instanceOf(error.cause, Error)
        assert.include(error.cause.message, "Hearth's proxy")
        assert.isTrue(error.retryable)
      })
    }
  )
})
