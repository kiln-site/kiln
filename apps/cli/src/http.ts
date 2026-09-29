import { cliErrorResponseSchema } from "@workspace/contracts"
import { Effect } from "effect"
import type { z } from "zod"

import type { KilnSession } from "./config.js"
import { commandError, type CliCommandError } from "./errors.js"

export const CLI_LONG_OPERATION_TIMEOUT_MS = 370_000

export interface CliRequestInit extends RequestInit {
  timeoutMs?: number | null
}

export const apiJsonEffect = Effect.fn("cli.http.json")(function* <TValue>(
  session: KilnSession,
  path: string,
  schema: z.ZodType<TValue>,
  init?: CliRequestInit
) {
  return yield* apiResponseEffect(session, path, init, (response) =>
    decodeResponseJson(response).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => schema.parse(body),
          catch: (cause) =>
            commandError({
              cause,
              code: "invalid_response",
              message:
                "Hearth returned a response the CLI does not understand.",
            }),
        })
      )
    )
  )
})

export const apiResponseEffect = Effect.fn("cli.http.request")(function* <
  TValue,
  TError,
  TRequirements,
>(
  session: KilnSession,
  path: string,
  init: CliRequestInit | undefined,
  use: (response: Response) => Effect.Effect<TValue, TError, TRequirements>
) {
  return yield* requestEffect(
    `${session.url}${path}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        "User-Agent": "kiln-cli/0.0.1",
        ...init?.headers,
      },
    },
    use
  )
})

export const publicJsonEffect = Effect.fn("cli.http.publicJson")(function* <
  TValue,
>(url: string, path: string, schema: z.ZodType<TValue>, init?: CliRequestInit) {
  return yield* requestEffect(
    `${url}${path}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "kiln-cli/0.0.1",
        ...init?.headers,
      },
    },
    (response) =>
      decodeResponseJson(response).pipe(
        Effect.flatMap((body) =>
          Effect.try({
            try: () => schema.parse(body),
            catch: (cause) =>
              commandError({
                cause,
                code: "invalid_response",
                message:
                  "Hearth returned a response the CLI does not understand.",
              }),
          })
        )
      )
  )
})

export const publicResponseEffect = Effect.fn("cli.http.publicResponse")(
  function* <TValue, TError, TRequirements>(
    url: string,
    init: CliRequestInit | undefined,
    use: (response: Response) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return yield* requestEffect(
      url,
      {
        ...init,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "kiln-cli/0.0.1",
          ...init?.headers,
        },
      },
      use
    )
  }
)

function requestEffect<TValue, TError, TRequirements>(
  url: string,
  init: CliRequestInit,
  use: (response: Response) => Effect.Effect<TValue, TError, TRequirements>
): Effect.Effect<TValue, CliCommandError | TError, TRequirements> {
  const { timeoutMs = 30_000, ...requestInit } = init
  return Effect.acquireUseRelease(
    Effect.sync(() => requestAbortScope(requestInit.signal, timeoutMs)),
    (abortScope) =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            ...requestInit,
            signal: abortScope.signal,
          }),
        catch: (cause) =>
          commandError({
            cause,
            code: "network_error",
            exitCode: 5,
            message: `Could not reach ${new URL(url).origin}.`,
            retryable: true,
          }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? use(response).pipe(
                Effect.mapError((cause) => cause as CliCommandError | TError)
              )
            : decodeErrorResponseJson(response).pipe(
                Effect.flatMap((body) => {
                  const parsed = cliErrorResponseSchema.safeParse(body)
                  const fallback = fallbackHttpError(response.status)
                  return Effect.fail(
                    commandError({
                      ...(parsed.success
                        ? parsed.data.error.cause
                          ? { cause: new Error(parsed.data.error.cause) }
                          : {}
                        : fallback.cause
                          ? { cause: fallback.cause }
                          : {}),
                      code: parsed.success
                        ? parsed.data.error.code
                        : `http_${response.status}`,
                      exitCode:
                        response.status === 401
                          ? 3
                          : response.status === 403
                            ? 4
                            : 1,
                      message: parsed.success
                        ? parsed.data.error.message
                        : fallback.message,
                      ...(parsed.success && parsed.data.error.requestId
                        ? { requestId: parsed.data.error.requestId }
                        : {}),
                      retryable: parsed.success
                        ? parsed.data.error.retryable
                        : fallback.retryable,
                    })
                  )
                })
              )
        ),
        Effect.onInterrupt(() => Effect.sync(() => abortScope.abort()))
      ),
    (abortScope) => Effect.sync(() => abortScope.close())
  ) as Effect.Effect<TValue, CliCommandError | TError, TRequirements>
}

function decodeErrorResponseJson(response: Response) {
  return decodeResponseJson(response).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: (body) => body,
    })
  )
}

function fallbackHttpError(status: number): {
  cause?: Error
  message: string
  retryable: boolean
} {
  if (status === 502) {
    return {
      cause: new Error(
        "No Kiln error details were returned; the request may have failed at Hearth's proxy."
      ),
      message: "The request returned HTTP 502.",
      retryable: true,
    }
  }
  return {
    message: `Hearth returned HTTP ${status}.`,
    retryable: false,
  }
}

function requestAbortScope(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | null
) {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  if (callerSignal?.aborted) {
    abort(callerSignal.reason)
  } else if (callerSignal) {
    const onAbort = () => abort(callerSignal.reason)
    callerSignal.addEventListener("abort", onAbort, { once: true })
    cleanups.push(() => callerSignal.removeEventListener("abort", onAbort))
  }

  if (timeoutMs !== null && !controller.signal.aborted) {
    const timeout = setTimeout(
      () => abort(new DOMException("The operation timed out.", "TimeoutError")),
      timeoutMs
    )
    cleanups.push(() => clearTimeout(timeout))
  }

  return {
    abort,
    close: () => {
      cleanups.forEach((cleanup) => cleanup())
    },
    signal: controller.signal,
  }
}

function decodeResponseJson(response: Response) {
  return Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      commandError({
        cause,
        code: "invalid_response",
        message: "Hearth returned invalid JSON.",
      }),
  })
}
