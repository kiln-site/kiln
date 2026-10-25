/**
 * Browser traces and errors. They are sent as OTLP JSON to Hearth, which
 * authenticates and samples them and forwards them to the configured OTLP
 * backend, so the browser holds no backend credentials.
 */
import type { ErrorContext } from "@workspace/telemetry"
import { describeException, logExceptionDetails } from "@workspace/telemetry"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Tracer,
} from "effect"
import { FetchHttpClient } from "effect/http"
import {
  OtlpExporter,
  OtlpLogger,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability"

import {
  browserTraceSampleRatioMeta,
  keepBrowserTrace,
} from "@/lib/browser-trace-sampling"
import { isExpectedAppError } from "@/observability/error-policy"

export interface BrowserSpan {
  readonly setAttribute: (key: string, value: unknown) => void
  /**
   * Ends the span once; later calls are ignored. `endedAt` is a
   * `performance.now()` time for work that finished before the call.
   */
  readonly end: (error?: unknown, endedAt?: number) => void
}

interface BrowserTelemetry {
  readonly runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>
  tracer: Tracer.Tracer | undefined
}

const noopSpan: BrowserSpan = { setAttribute: () => {}, end: () => {} }
const spans = new WeakMap<BrowserSpan, Tracer.Span>()
let telemetry: BrowserTelemetry | undefined

export function runBrowserEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options?: { signal?: AbortSignal }
): Promise<A> {
  return telemetry
    ? telemetry.runtime.runPromise(effect, options)
    : Effect.runPromise(effect, options)
}

/** Starts exporting browser telemetry and reporting uncaught errors. */
export function startBrowserTelemetry(): void {
  if (telemetry || typeof window === "undefined") return
  const endpoint = (signal: "logs" | "traces") =>
    new URL(`/api/telemetry/v1/${signal}`, window.location.origin).toString()
  const resource = { serviceName: "hearth-browser" }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(
        Tracer.Tracer,
        // Batches stay under the 64 KiB limit for keepalive requests, so
        // spans still leave the page while it unloads.
        OtlpTracer.make({ url: endpoint("traces"), resource, maxBatchSize: 50 })
      ),
      Logger.layer(
        [OtlpLogger.make({ url: endpoint("logs"), resource, maxBatchSize: 5 })],
        { mergeWithExisting: false }
      )
    ).pipe(
      Layer.provideMerge(OtlpExporter.layerFlusher),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, { keepalive: true })
      )
    )
  )
  const current: BrowserTelemetry = { runtime, tracer: undefined }
  telemetry = current
  runtime.runFork(
    Effect.gen(function* () {
      current.tracer = yield* Tracer.Tracer
    })
  )
  window.addEventListener("error", (event) => {
    reportBrowserError(event.error ?? event.message, {
      operation: "window.error",
    })
  })
  window.addEventListener("unhandledrejection", (event) => {
    reportBrowserError(event.reason, {
      operation: "window.unhandledrejection",
    })
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return
    runtime.runFork(
      Effect.gen(function* () {
        const flusher = yield* OtlpExporter.Flusher
        yield* flusher.flush
      })
    )
  })
}

/**
 * Reports an unexpected error with its exception details and fingerprint.
 * Expected outcomes such as failed authentication are skipped.
 */
export function reportBrowserError(
  cause: unknown,
  context?: ErrorContext
): void {
  if (isExpectedAppError(cause)) return
  telemetry?.runtime.runFork(
    logExceptionDetails(describeException(cause), {
      ...context,
      attributes: { ...context?.attributes, "url.path": location.pathname },
    })
  )
}

/** Starts a span that the caller ends; children name it as their parent. */
export function startBrowserSpan(
  name: string,
  options?: {
    readonly attributes?: Record<string, unknown>
    readonly parent?: BrowserSpan | undefined
    // A `performance.now()` time the span began at, for work that started
    // before anything could start a span, such as a navigation.
    readonly startedAt?: number
  }
): BrowserSpan {
  const tracer = telemetry?.tracer
  if (!tracer) return noopSpan
  const parent = options?.parent ? spans.get(options.parent) : undefined
  const span = tracer.span({
    name,
    parent: parent ? Option.some(parent) : Option.none(),
    annotations: Context.empty(),
    links: [],
    startTime: nowNanos(options?.startedAt),
    kind: "internal",
    root: parent === undefined,
    sampled: true,
  })
  for (const [key, value] of Object.entries(options?.attributes ?? {})) {
    span.attribute(key, value)
  }
  let ended = false
  const browserSpan: BrowserSpan = {
    setAttribute: (key, value) => span.attribute(key, value),
    end: (error, endedAt) => {
      if (ended) return
      ended = true
      span.end(
        nowNanos(endedAt),
        error === undefined ? Exit.void : Exit.fail(error)
      )
    },
  }
  spans.set(browserSpan, span)
  return browserSpan
}

/**
 * A W3C `traceparent` for work another service does within `span`, such as
 * a Relay's. It is marked sampled only when Hearth will keep the browser's
 * own spans of that trace, so the two halves are kept or dropped together.
 * Undefined while Hearth forwards no browser traces.
 */
export function browserTraceparent(
  span: BrowserSpan | undefined
): string | undefined {
  const traced = span ? spans.get(span) : undefined
  return traced ? sampledTraceparent(traced) : undefined
}

/**
 * The `traceparent` for work another service does within the current
 * effect's span, sampled as `browserTraceparent` is. Undefined outside
 * `runBrowserEffect` or while Hearth forwards no browser traces.
 */
export const currentBrowserTraceparent: Effect.Effect<string | undefined> =
  Effect.gen(function* () {
    if (!telemetry?.tracer) return undefined
    const span = yield* Effect.option(Effect.currentSpan)
    return Option.isSome(span) ? sampledTraceparent(span.value) : undefined
  })

function sampledTraceparent(span: {
  readonly spanId: string
  readonly traceId: string
}): string | undefined {
  const ratio = Number(
    document
      .querySelector(`meta[name="${browserTraceSampleRatioMeta}"]`)
      ?.getAttribute("content") ?? Number.NaN
  )
  if (!Number.isFinite(ratio)) return undefined
  const sampled = keepBrowserTrace(span.traceId, ratio)
  return `00-${span.traceId}-${span.spanId}-${sampled ? "01" : "00"}`
}

/** Traces promise code, marking the span failed when it rejects. */
export async function traceBrowser<TResult>(
  name: string,
  attributes: Record<string, unknown>,
  run: (span: BrowserSpan) => Promise<TResult>
): Promise<TResult> {
  const span = startBrowserSpan(name, { attributes })
  return Effect.runPromise(
    Effect.tryPromise({ try: () => run(span), catch: (cause) => cause }).pipe(
      Effect.tapError((cause) => Effect.sync(() => span.end(cause))),
      Effect.tap(() => Effect.sync(() => span.end()))
    )
  )
}

function nowNanos(at = performance.now()): bigint {
  return BigInt(Math.round((performance.timeOrigin + at) * 1e6))
}
