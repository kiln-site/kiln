import * as Telemetry from "@workspace/telemetry"
import { Effect, Layer, ManagedRuntime, Option, Tracer } from "effect"
import type { Fiber } from "effect"
import { Headers, HttpTraceContext } from "effect/http"

import { makeRelayStateLayer, RelayStateStore } from "./state.js"
import { relayBuildCommit, relayBuildVersion } from "../build-info.js"
import { relayStateDatabasePath, type RelayConfig } from "../config.js"
import { savedInstallationId } from "../installation.js"

declare const __KILN_TELEMETRY_DEFAULTS__: Telemetry.TelemetryDefaults

// Baked at pack time from the release's OTEL_* variables; absent when run
// from source. The environment overrides them.
const telemetryDefaults: Telemetry.TelemetryDefaults =
  typeof __KILN_TELEMETRY_DEFAULTS__ === "undefined"
    ? {}
    : __KILN_TELEMETRY_DEFAULTS__

let runtime: ManagedRuntime.ManagedRuntime<RelayStateStore, unknown> | null =
  null

export function initializeRelayRuntime(config: RelayConfig): void {
  if (runtime) return
  // The installation ID is the one saved when the Relay starts; one Hearth
  // sends later is reported from the next start.
  const telemetry = Layer.unwrap(
    Effect.gen(function* () {
      const installationId = config.installationIdConfigured
        ? config.installationId
        : yield* savedInstallationId(yield* RelayStateStore).pipe(
            Effect.orElseSucceed(() => null)
          )
      return Telemetry.layer(
        {
          serviceName: "relay",
          serviceVersion: relayBuildVersion,
          attributes: {
            ...(relayBuildCommit
              ? { "vcs.ref.head.revision": relayBuildCommit }
              : {}),
            ...(installationId
              ? { "kiln.installation_id": installationId }
              : {}),
          },
        },
        telemetryDefaults
      )
    })
  )
  runtime = ManagedRuntime.make(
    telemetry.pipe(
      Layer.provideMerge(makeRelayStateLayer(relayStateDatabasePath(config)))
    )
  )
}

export function runRelayEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, RelayStateStore>
): Promise<TResult> {
  return activeRuntime().runPromise(
    Telemetry.withActiveParent(Effect.withSpan(effect, name))
  )
}

/**
 * Runs an effect for a request the Relay serves, such as a direct transfer,
 * which names its own span. Before the Relay runtime exists, as in tests,
 * it runs without exporting.
 */
export function runRelayRequest<TResult, TError>(
  effect: Effect.Effect<TResult, TError>
): Promise<TResult> {
  return runtime ? runtime.runPromise(effect) : Effect.runPromise(effect)
}

/** Runs a hot-path effect, such as a snapshot read, without tracing it. */
export function runRelayEffectUntraced<TResult, TError>(
  effect: Effect.Effect<TResult, TError, RelayStateStore>
): Promise<TResult> {
  return activeRuntime().runPromise(Effect.withTracerEnabled(effect, false))
}

/**
 * Traces promise code; effects it runs become child spans. Before the Relay
 * runtime exists the span is created but not exported.
 */
export function traceRelayPromise<TResult>(
  name: string,
  run: (span: Tracer.Span) => Promise<TResult>,
  attributes?: Record<string, unknown>,
  // A span to nest under instead of the active one, such as a browser's.
  parent?: Tracer.AnySpan
): Promise<TResult> {
  const span = Telemetry.spanPromise(
    name,
    run,
    attributes ? { attributes } : undefined
  )
  const traced = parent
    ? Effect.withParentSpan(span, parent)
    : Telemetry.withActiveParent(span)
  return runtime ? runtime.runPromise(traced) : Effect.runPromise(traced)
}

/**
 * Runs an effect in a span exported through the Relay runtime, so the
 * effects and promise code it runs nest under it. Before the Relay runtime
 * exists the span is created but not exported.
 */
export function traceRelayEffect<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: Record<string, unknown>,
  // A span to nest under instead of the active one, such as Hearth's.
  parent?: Tracer.AnySpan
): Effect.Effect<A, E, R> {
  const span = Effect.withSpan(
    effect,
    name,
    attributes ? { attributes } : undefined
  )
  const traced = parent
    ? Effect.withParentSpan(span, parent)
    : Telemetry.withActiveParent(span)
  return runtime
    ? Effect.withTracer(traced, runtime.runSync(Effect.tracer))
    : traced
}

/**
 * The span a W3C `traceparent` names, such as a browser's or Hearth's, so
 * the Relay's work joins that trace and follows its sampling.
 */
export function traceParentSpan(
  traceparent: unknown
): Tracer.ExternalSpan | undefined {
  if (typeof traceparent !== "string" || traceparent.length > 64) {
    return undefined
  }
  return Option.getOrUndefined(
    HttpTraceContext.w3c(Headers.fromInput({ traceparent }))
  )
}

/**
 * A W3C `traceparent` for work another service does within the current
 * span, such as another Relay's, or none when no traces are kept.
 */
export const currentTraceparent: Effect.Effect<string | undefined> = Effect.gen(
  function* () {
    if ((yield* Effect.tracer) === Tracer.nativeTracer) return undefined
    const span = yield* Effect.option(Effect.currentSpan)
    return Option.isSome(span)
      ? HttpTraceContext.toHeaders(span.value).traceparent
      : undefined
  }
)

/**
 * Forks a long-lived worker. It gets no span of its own: a span only exports
 * when it ends, so the operations inside it start their own traces.
 */
export function forkRelayEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, RelayStateStore>
): Fiber.Fiber<TResult, unknown> {
  return activeRuntime().runFork(
    effect.pipe(Effect.annotateLogs({ "kiln.worker": name }))
  )
}

/**
 * Exports an error as an error log. Safe to call from any code, including
 * effects run outside the Relay runtime and before it is initialized.
 */
export function reportRelayError(
  cause: unknown,
  context?: Telemetry.ErrorContext
): void {
  if (!runtime) {
    console.error(cause)
    return
  }
  runtime.runFork(
    Telemetry.withActiveParent(Telemetry.logException(cause, context))
  )
}

export async function disposeRelayRuntime(): Promise<void> {
  await runtime?.dispose()
  runtime = null
}

function activeRuntime(): ManagedRuntime.ManagedRuntime<
  RelayStateStore,
  unknown
> {
  if (!runtime) {
    throw new Error("Relay Effect runtime has not been initialized")
  }
  return runtime
}
