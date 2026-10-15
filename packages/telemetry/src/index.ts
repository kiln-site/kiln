/**
 * OpenTelemetry export for Hearth and Relays, configured only through the
 * standard OTEL_* environment variables so any OTLP backend works:
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`: nothing
 *   is exported without an endpoint
 * - `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`: a
 *   signal is exported only when its variable includes `otlp`. Traces and
 *   logs default to `otlp`; metrics default to off. `none` turns one off.
 * - `OTEL_TRACES_SAMPLER_ARG`: share of traces kept (default 0.05)
 * - `OTEL_RESOURCE_ATTRIBUTES`, e.g. `deployment.environment.name=production`
 *
 * Header values are URI-decoded, so `=` inside a value is written `%3D`.
 * Builds can bake defaults for these variables; the environment overrides
 * them. Defaults live in the bundle rather than the image environment because
 * the Relay updater carries a container's environment into its replacement.
 *
 * Errors are exported as error logs carrying `exception.*` attributes and a
 * stable `error.fingerprint`, so they can be grouped without span events.
 */
import type { AsyncLocalStorage } from "node:async_hooks"

import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Tracer,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"

export interface TelemetryResource {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}

export interface ErrorContext {
  /** Stable name of the failing operation; part of the fingerprint. */
  readonly operation?: string | undefined
  readonly attributes?:
    | Readonly<Record<string, string | number | boolean | null | undefined>>
    | undefined
}

export interface OtlpTarget {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Share of traces to keep, from `OTEL_TRACES_SAMPLER_ARG`. */
  readonly sampleRatio: number
}

export interface ExceptionDetails {
  readonly type: string
  readonly message: string
  readonly stacktrace: string
}

const defaultSampleRatio = 0.05
const maxCauseDepth = 3

// The span of the Effect currently evaluating, visible to promise code it
// calls. Effects started from that code use it as their parent, so one
// request stays one trace across runtime boundaries. Created on first use so
// browsers can import the exception helpers.
let activeSpan: AsyncLocalStorage<Tracer.AnySpan> | undefined
const spanStorage = () =>
  (activeSpan ??= new (process.getBuiltinModule(
    "node:async_hooks"
  ).AsyncLocalStorage)<Tracer.AnySpan>())

/**
 * Exports traces, logs and metrics over OTLP. Without an endpoint this
 * provides nothing and Effect keeps its defaults. Invalid
 * configuration disables telemetry instead of failing the runtime.
 */
export const layer = (
  resource: TelemetryResource,
  defaults: TelemetryDefaults = {}
): Layer.Layer<never> =>
  Layer.effect(Tracer.Tracer, sampledTracer).pipe(
    Layer.provideMerge(
      Otlp.layerFromConfig({ resource, loggerMergeWithExisting: true })
    ),
    Layer.provide(OtlpSerialization.layerProtobuf),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(configDefaults(defaults)),
    Layer.catchCause((cause) => {
      console.error(
        "Telemetry is disabled because its OTEL_* configuration is invalid",
        Cause.pretty(cause)
      )
      return Layer.empty
    })
  )

export type TelemetryDefaults = Readonly<Record<string, string | undefined>>

/**
 * Where to forward a signal received from elsewhere, such as a browser, using
 * the same OTEL_* configuration as `layer`. None when the signal is disabled
 * or the configuration is invalid.
 */
export const otlpTarget = (
  signal: "logs" | "traces",
  defaults: TelemetryDefaults = {}
): Effect.Effect<Option.Option<OtlpTarget>> => {
  const name = signal.toUpperCase()
  return Effect.gen(function* () {
    const disabled = yield* Config.Boolean("OTEL_SDK_DISABLED").pipe(
      Config.withDefault(false)
    )
    const exporters = yield* Config.Array(
      Schema.String,
      `OTEL_${name}_EXPORTER`
    ).pipe(Config.withDefault<ReadonlyArray<string>>([]))
    if (
      disabled ||
      !exporters.some((value) => value.trim().toLowerCase() === "otlp")
    ) {
      return Option.none()
    }
    const signalEndpoint = yield* Config.URL(
      `OTEL_EXPORTER_OTLP_${name}_ENDPOINT`
    ).pipe(Config.withDefault(undefined))
    const baseEndpoint = yield* Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
      Config.withDefault(undefined)
    )
    if (!signalEndpoint && baseEndpoint) {
      // The path is extended, not the string, so query parameters survive.
      baseEndpoint.pathname = `${baseEndpoint.pathname.replace(/\/$/u, "")}/v1/${signal}`
    }
    const url = (signalEndpoint ?? baseEndpoint)?.toString()
    if (!url) return Option.none()
    const headers = yield* headersConfig(
      `OTEL_EXPORTER_OTLP_${name}_HEADERS`
    ).pipe(
      Config.orElse(() => headersConfig("OTEL_EXPORTER_OTLP_HEADERS")),
      Config.withDefault({})
    )
    return Option.some({ url, headers, sampleRatio: yield* sampleRatio })
  }).pipe(
    Effect.provide(configDefaults(defaults)),
    Effect.orElseSucceed(() => Option.none())
  )
}

const headersConfig = (name: string) =>
  Config.Record(Schema.String, Schema.StringFromUriComponent, name)

const sampleRatio = Config.Number("OTEL_TRACES_SAMPLER_ARG").pipe(
  Config.map((value) =>
    Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : defaultSampleRatio
  ),
  Config.withDefault(defaultSampleRatio)
)

// Traces and logs export whenever an endpoint is set. Metrics stay opt-in
// because some backends, such as Sentry, reject them.
const signalDefaults: TelemetryDefaults = {
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
}

const configDefaults = (defaults: TelemetryDefaults) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromUnknown({
      ...signalDefaults,
      ...Object.fromEntries(
        Object.entries(defaults).filter(([, value]) => value?.trim())
      ),
    })
  )

const sampledTracer = Effect.gen(function* () {
  const tracer = yield* Tracer.Tracer
  if (tracer === Tracer.nativeTracer) return tracer
  const storage = spanStorage()
  const ratio = yield* sampleRatio
  return Tracer.make({
    span(options) {
      // Decide once per trace; child spans inherit `sampled` from the root.
      return tracer.span(
        options.root && options.sampled
          ? { ...options, sampled: Math.random() < ratio }
          : options
      )
    },
    context(primitive, fiber) {
      const span = fiber.cache.span
      return span === undefined
        ? primitive["~effect/Effect/evaluate"](fiber)
        : storage.run(span, () => primitive["~effect/Effect/evaluate"](fiber))
    },
  })
}).pipe(Effect.orDie)

/** Nests an effect started from promise code under the active span there. */
export const withActiveParent = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const parent = activeSpan?.getStore()
  return parent === undefined
    ? effect
    : (Effect.withParentSpan(effect, parent) as Effect.Effect<A, E, R>)
}

/** Runs promise code inside a span, so effects it starts nest under it. */
export const spanPromise = <A>(
  name: string,
  run: (span: Tracer.Span) => Promise<A>,
  options?: Tracer.SpanOptions
): Effect.Effect<A, unknown> =>
  Effect.currentSpan.pipe(
    Effect.orDie,
    Effect.flatMap((span) =>
      Effect.tryPromise({ try: () => run(span), catch: (cause) => cause })
    ),
    Effect.withSpan(name, options)
  )

/** Logs an error with its exception details and fingerprint. */
export const logException = (
  cause: unknown,
  context: ErrorContext = {}
): Effect.Effect<void> => {
  const exception = describeException(cause)
  return logExceptionDetails(exception, context)
}

/** Logs an error described elsewhere, such as a browser report. */
export const logExceptionDetails = (
  exception: ExceptionDetails,
  context: ErrorContext = {}
): Effect.Effect<void> => {
  const annotations: Record<string, unknown> = {
    "exception.type": exception.type,
    "exception.message": exception.message,
    "exception.stacktrace": exception.stacktrace,
    "error.fingerprint": errorFingerprint(exception, context.operation),
  }
  if (context.operation) annotations["kiln.operation"] = context.operation
  for (const [key, value] of Object.entries(context.attributes ?? {})) {
    if (value !== undefined && value !== null) annotations[key] = value
  }
  return Effect.logError(exception.message).pipe(
    Effect.annotateLogs(annotations)
  )
}

export function describeException(cause: unknown): ExceptionDetails {
  const error = Cause.isCause(cause) ? Cause.squash(cause) : cause
  const type = exceptionType(error)
  const message = exceptionMessage(error)
  return { type, message, stacktrace: stacktrace(error, type, message, 0) }
}

/**
 * Groups occurrences of the same error: the type, the message with
 * identifiers and numbers removed, and the operation. Stack frames are left
 * out because minified bundles change them every release.
 */
export function errorFingerprint(
  exception: Pick<ExceptionDetails, "type" | "message">,
  operation?: string
): string {
  const message = exception.message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
      "<id>"
    )
    .replace(/\b[0-9a-f]{12,}\b/giu, "<id>")
    .replace(/\d+/gu, "<n>")
    .slice(0, 300)
  return fnv1a(`${exception.type}\n${message}\n${operation ?? ""}`)
}

function exceptionType(error: unknown): string {
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) {
    return error._tag
  }
  if (error instanceof Error) return error.name
  return Predicate.isString(error) ? "Error" : typeof error
}

function exceptionMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (Predicate.isString(error)) return error
  if (
    Predicate.hasProperty(error, "message") &&
    Predicate.isString(error.message)
  ) {
    return error.message
  }
  return String(error)
}

function stacktrace(
  error: unknown,
  type: string,
  message: string,
  depth: number
): string {
  const own =
    error instanceof Error && error.stack ? error.stack : `${type}: ${message}`
  if (
    depth >= maxCauseDepth ||
    !(error instanceof Error) ||
    error.cause === undefined
  ) {
    return own
  }
  const cause = error.cause
  const causeType = exceptionType(cause)
  const causeMessage = exceptionMessage(cause)
  return `${own}\nCaused by: ${stacktrace(cause, causeType, causeMessage, depth + 1)}`
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
