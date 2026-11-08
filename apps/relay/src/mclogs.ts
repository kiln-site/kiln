import { Effect, Schema } from "effect"

import type {
  RelayConsoleShareInput,
  RelayMclogsUploadResult,
} from "@workspace/contracts"

import type { DockerConsoleLog } from "./docker.js"
import { MclogsUploadError } from "./effect/errors.js"

const MclogsResponseSchema = Schema.Struct({
  expires: Schema.Number,
  id: Schema.String,
  success: Schema.Literal(true),
  url: Schema.String,
})

export const uploadConsoleLogToMclogs = Effect.fn("mclogs.upload")(function* (
  endpoint: string,
  log: DockerConsoleLog,
  input: RelayConsoleShareInput
) {
  const timeout = AbortSignal.timeout(20_000)
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: input.redactSensitive
            ? redactSensitiveText(log.content)
            : log.content,
          source: "Kiln",
          metadata: [
            {
              key: "server",
              label: "Server",
              value: log.instanceId,
              visible: true,
            },
            {
              key: "software",
              label: "Software",
              value: `${input.implementation} ${input.version}`,
              visible: true,
            },
            {
              key: "path",
              label: "Source file",
              value: log.path,
              visible: true,
            },
          ],
        }),
        signal: timeout,
      }),
    catch: (cause) =>
      MclogsUploadError.make({
        reason: timeout.aborted
          ? "mclo.gs upload timed out after 20 seconds"
          : `Could not upload to mclo.gs: ${errorMessage(cause)}`,
        cause,
      }),
  })

  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      MclogsUploadError.make({
        reason: "mclo.gs returned an invalid response",
        cause,
      }),
  })
  const responseMessage = apiErrorMessage(payload)
  if (!response.ok) {
    return yield* Effect.fail(
      MclogsUploadError.make({
        reason: responseMessage ?? `mclo.gs returned HTTP ${response.status}`,
      })
    )
  }

  const result = yield* Schema.decodeUnknownEffect(MclogsResponseSchema)(
    payload
  ).pipe(
    Effect.flatMap((decoded) =>
      Schema.decodeUnknownEffect(Schema.URLFromString)(decoded.url).pipe(
        Effect.as(decoded)
      )
    ),
    Effect.mapError((cause) =>
      MclogsUploadError.make({
        reason: responseMessage ?? "mclo.gs returned an invalid response",
        cause,
      })
    )
  )
  return {
    expires: result.expires,
    id: result.id,
    url: result.url,
  } satisfies RelayMclogsUploadResult
})

function apiErrorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error
  }
  return undefined
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/gu,
      (candidate) =>
        candidate
          .split(".")
          .map(() => "***")
          .join(".")
    )
    .replace(
      /(?<![\w:])(?:[a-f\d]{0,4}:){2,7}[a-f\d]{0,4}(?![\w:])/giu,
      (candidate) =>
        candidate.includes("::") || candidate.split(":").length - 1 >= 5
          ? candidate.replace(/[a-f\d]/giu, "*")
          : candidate
    )
}
