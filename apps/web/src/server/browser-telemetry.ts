import { otlpTarget } from "@workspace/telemetry"
import type { OtlpTarget } from "@workspace/telemetry"
import { Effect, Option } from "effect"
import { z } from "zod"

import { telemetryDefaults } from "@/effect/runtime"
import { getAuthenticatedRealtimeIdentityFromHeaders } from "@/lib/auth-session"
import { keepBrowserTrace } from "@/lib/browser-trace-sampling"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"

const maximumBodyBytes = 256 * 1024
const requestsPerMinute = 120
const upstreamTimeoutMs = 10_000

const attributesSchema = z.array(z.unknown()).max(64)
const tracesSchema = z.object({
  resourceSpans: z
    .array(
      z.object({
        scopeSpans: z
          .array(
            z
              .object({
                spans: z
                  .array(
                    z.looseObject({
                      traceId: z.string().regex(/^[0-9a-f]{32}$/iu),
                    })
                  )
                  .max(500),
              })
              .loose()
          )
          .max(16),
      })
    )
    .max(4),
})
const logsSchema = z.object({
  resourceLogs: z
    .array(
      z.object({
        scopeLogs: z
          .array(
            z
              .object({
                logRecords: z
                  .array(
                    z.looseObject({ attributes: attributesSchema.optional() })
                  )
                  .max(100),
              })
              .loose()
          )
          .max(16),
      })
    )
    .max(4),
})

/**
 * Forwards OTLP JSON from a signed-in browser to the configured backend. The
 * browser cannot name itself as another service, traces are sampled here by
 * trace ID, and the backend credentials never leave Hearth.
 */
export async function forwardBrowserTelemetry(
  request: Request,
  signal: string
): Promise<Response> {
  if (signal !== "traces" && signal !== "logs") return status(404)
  const identity = await getAuthenticatedRealtimeIdentityFromHeaders(
    request.headers
  )
  if (!identity) return status(401)
  const limited = Effect.runSync(
    Effect.try(() =>
      assertRequestRateLimit(
        `browser-telemetry:${identity.user.id}`,
        requestsPerMinute,
        60_000
      )
    ).pipe(
      Effect.as(false),
      Effect.orElseSucceed(() => true)
    )
  )
  if (limited) return status(429)

  const body = await readLimitedText(request, maximumBodyBytes)
  if (body === null) return status(413)
  const payload = Effect.runSync(
    Effect.try(() => JSON.parse(body) as unknown).pipe(
      Effect.orElseSucceed(() => undefined)
    )
  )

  const target = await Effect.runPromise(otlpTarget(signal, telemetryDefaults))
  const resource = {
    attributes: [
      { key: "service.name", value: { stringValue: "hearth-browser" } },
      {
        key: "service.version",
        value: { stringValue: import.meta.env.VITE_KILN_VERSION },
      },
    ],
  }
  let forwarded: unknown
  if (signal === "traces") {
    const traces = tracesSchema.safeParse(payload)
    if (!traces.success) return status(400)
    if (Option.isNone(target)) return status(204)
    const ratio = browserTraceSampleRatio(target.value)
    const resourceSpans = traces.data.resourceSpans
      .map((entry) => ({
        resource,
        scopeSpans: entry.scopeSpans
          .map((scope) => ({
            ...scope,
            spans: scope.spans.filter((span) =>
              keepBrowserTrace(span.traceId, ratio)
            ),
          }))
          .filter((scope) => scope.spans.length > 0),
      }))
      .filter((entry) => entry.scopeSpans.length > 0)
    if (resourceSpans.length === 0) return status(204)
    forwarded = { resourceSpans }
  } else {
    const logs = logsSchema.safeParse(payload)
    if (!logs.success) return status(400)
    if (Option.isNone(target)) return status(204)
    forwarded = {
      resourceLogs: logs.data.resourceLogs.map((entry) => ({
        ...entry,
        resource,
      })),
    }
  }

  const { url, headers } = target.value
  await Effect.runPromise(
    Effect.tryPromise(() =>
      fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(forwarded),
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
    ).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.void
          : Effect.logWarning("OTLP backend rejected browser telemetry", {
              signal,
              status: response.status,
            })
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not forward browser telemetry", {
          cause,
          signal,
        })
      )
    )
  )
  return status(204)
}

/** The share of browser traces Hearth forwards. */
export function browserTraceSampleRatio(_target: OtlpTarget): number {
  // Temporarily keeps every browser trace to baseline instance page opens in
  // production; restore `_target.sampleRatio` once that is done.
  return 1
}

async function readLimitedText(
  request: Request,
  limit: number
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function status(code: number): Response {
  return new Response(null, { status: code })
}
