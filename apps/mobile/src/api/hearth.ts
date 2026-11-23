import { cliErrorResponseSchema } from "@workspace/contracts/cli"
import { Duration, Effect, Schema } from "effect"
import { z } from "zod"

/** A signed-in Hearth: its origin and the CLI credential the app holds. */
export interface HearthSession {
  readonly url: string
  readonly token: string
  readonly credential: {
    readonly id: string
    readonly mode: "full_access" | "read_only"
    readonly name: string
    readonly expiresAt: string | null
  }
}

export class HearthError extends Schema.TaggedError<HearthError>()(
  "HearthError",
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const REQUEST_TIMEOUT_MS = 20_000
const USER_AGENT = "kiln-mobile/0.0.1"

/** Normalizes what someone types into the origin the API lives under. */
export function normalizeHearthUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/u, "")
  if (!trimmed) return null
  const withScheme = /^https?:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return URL.canParse(withScheme) ? new URL(withScheme).origin : null
}

const request = Effect.fn("Hearth.request")(function* <TValue>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<TValue>
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        ...init,
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          ...init.headers,
        },
      }),
    catch: (cause) =>
      HearthError.make({
        code: "network_error",
        message: `Could not reach ${new URL(url).host}.`,
        status: 0,
        retryable: true,
        cause,
      }),
  }).pipe(
    // Interrupting the request aborts its signal, cancelling the fetch.
    Effect.timeoutOrElse({
      duration: Duration.millis(REQUEST_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          HearthError.make({
            code: "timeout",
            message: `${new URL(url).host} took too long to answer.`,
            status: 0,
            retryable: true,
          })
        ),
    })
  )
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) =>
      HearthError.make({
        code: "invalid_response",
        message: `Hearth answered ${response.status} without JSON. Is this a Hearth URL?`,
        status: response.status,
        retryable: false,
        cause,
      }),
  })
  if (!response.ok) {
    const failure = cliErrorResponseSchema.safeParse(body)
    return yield* HearthError.make(
      failure.success
        ? {
            code: failure.data.error.code,
            message: failure.data.error.message,
            status: response.status,
            retryable: failure.data.error.retryable,
          }
        : {
            code: "http_error",
            message: `Hearth answered ${response.status}.`,
            status: response.status,
            retryable: response.status >= 500,
          }
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return yield* HearthError.make({
      code: "invalid_response",
      message: "Hearth returned a response this app does not understand.",
      status: response.status,
      retryable: false,
      cause: parsed.error,
    })
  }
  return parsed.data
})

/** An unauthenticated call, for the device sign-in endpoints. */
export const publicRequest = <TValue>(
  origin: string,
  path: string,
  schema: z.ZodType<TValue>,
  init: RequestInit = {}
) => request(`${origin}${path}`, init, schema)

/** A call to the CLI API with the session's bearer token. */
export const apiRequest = <TValue>(
  session: HearthSession,
  path: string,
  schema: z.ZodType<TValue>,
  init: RequestInit = {}
) =>
  request(
    `${session.url}/api/cli/v1/${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${session.token}`, ...init.headers },
    },
    schema
  )

// Mirrors the CLI's inline schema for `DELETE /api/cli/v1/credential`.
export const cliRevokeResponseSchema = z.object({ revoked: z.literal(true) })

export const isHearthError = Schema.is(HearthError)

export function errorMessage(error: unknown): string {
  if (isHearthError(error)) return error.message
  return error instanceof Error ? error.message : "Something went wrong."
}
