import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"
import { z } from "zod"

import type { KilnSession } from "./config.js"
import { apiJsonEffect, apiResponseEffect } from "./http.js"

const session: KilnSession = {
  profile: "test",
  token: "kiln_cli_test",
  url: "https://kiln.example.test",
}

const okSchema = z.object({ ok: z.boolean() })

// Fakes the network boundary. Without `respond`, the request hangs until it is
// aborted.
function stubFetch(
  respond?: (signal: AbortSignal) => Response | Promise<Response>
) {
  let markStarted: (signal: AbortSignal) => void = () => undefined
  const started = new Promise<AbortSignal>((resolve) => {
    markStarted = resolve
  })
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const signal = init?.signal
    if (!signal) throw new Error("Every CLI request must be abortable")
    markStarted(signal)
    if (respond) return respond(signal)
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })
  })
  return started
}

// A JSON body that stalls after its headers and errors when aborted, like a
// real fetch body.
function stalledBody(signal: AbortSignal) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true }
        )
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  )
}

function failureCode<A, E extends { code: string }>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause) as Partial<E>
  return error.code ?? "defect"
}

describe("CLI HTTP requests", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("aborts the request when its deadline passes", async () => {
    const started = stubFetch()
    const result = Effect.runPromiseExit(
      apiResponseEffect(
        session,
        "/api/cli/v1/power",
        { timeoutMs: 1_000 },
        () => Effect.void
      )
    )
    const signal = await started

    vi.advanceTimersByTime(999)
    assert.isFalse(signal.aborted)
    vi.advanceTimersByTime(1)
    assert.isTrue(signal.aborted)
    assert.strictEqual(failureCode(await result), "network_error")
  })

  it("keeps the deadline active while decoding a response body", async () => {
    const started = stubFetch(stalledBody)
    const result = Effect.runPromiseExit(
      apiJsonEffect(session, "/api/cli/v1/stalled", okSchema, {
        timeoutMs: 1_000,
      })
    )
    const signal = await started

    vi.advanceTimersByTime(1_000)
    assert.isTrue(signal.aborted)
    assert.strictEqual(failureCode(await result), "invalid_response")
  })

  it("aborts the request when the caller cancels", async () => {
    const caller = new AbortController()
    const started = stubFetch()
    const result = Effect.runPromiseExit(
      apiResponseEffect(
        session,
        "/api/cli/v1/power",
        { signal: caller.signal, timeoutMs: null },
        () => Effect.void
      )
    )
    const signal = await started

    caller.abort(new DOMException("caller stopped", "AbortError"))
    assert.isTrue(signal.aborted)
    assert.strictEqual(failureCode(await result), "network_error")
  })

  it("aborts the request when the Effect is interrupted", async () => {
    const started = stubFetch()
    const fiber = Effect.runFork(
      apiResponseEffect(
        session,
        "/api/cli/v1/logs",
        { timeoutMs: null },
        () => Effect.void
      )
    )
    const signal = await started

    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.isTrue(signal.aborted)
  })

  it("releases the caller signal and deadline once the request finishes", async () => {
    const caller = new AbortController()
    const started = stubFetch(async () => Response.json({ ok: true }))

    const body = await Effect.runPromise(
      apiJsonEffect(session, "/api/cli/v1/whoami", okSchema, {
        signal: caller.signal,
      })
    )
    const signal = await started

    assert.deepStrictEqual(body, { ok: true })
    // A pending deadline timer would keep the CLI process alive after output.
    assert.strictEqual(vi.getTimerCount(), 0)
    caller.abort()
    assert.isFalse(signal.aborted)
  })

  it("preserves structured Relay failure details", async () => {
    const requestId = "3df56ba5-b2c1-45ee-bab7-386fbb9223c7"
    void stubFetch(async () =>
      Response.json(
        {
          error: {
            cause: "Survival is not running",
            code: "relay_operation_failed",
            message: "Relay could not send the console command.",
            requestId,
            retryable: false,
          },
        },
        { status: 502 }
      )
    )

    const error = await Effect.runPromise(
      apiJsonEffect(session, "/api/cli/v1/console", okSchema).pipe(Effect.flip)
    )

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

  it("treats a 502 without Kiln error details as a retryable proxy failure", async () => {
    void stubFetch(
      async () =>
        new Response("Bad Gateway", {
          headers: { "Content-Type": "text/plain" },
          status: 502,
        })
    )

    const error = await Effect.runPromise(
      apiJsonEffect(session, "/api/cli/v1/console", okSchema).pipe(Effect.flip)
    )

    assert.strictEqual(error.code, "http_502")
    assert.instanceOf(error.cause, Error)
    assert.isTrue(error.retryable)
  })
})
