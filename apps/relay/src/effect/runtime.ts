import * as Telemetry from "@workspace/telemetry"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { Fiber, Tracer } from "effect"

import { makeRelayStateLayer, RelayStateStore } from "./state.js"
import { relayBuildCommit, relayBuildVersion } from "../build-info.js"
import type { RelayConfig } from "../config.js"

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
  runtime = ManagedRuntime.make(
    Layer.merge(
      makeRelayStateLayer(`${config.dataDirectory}/network/relay.sqlite`),
      Telemetry.layer(
        {
          serviceName: "relay",
          serviceVersion: relayBuildVersion,
          attributes: relayBuildCommit
            ? { "vcs.ref.head.revision": relayBuildCommit }
            : undefined,
        },
        telemetryDefaults
      )
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
  attributes?: Record<string, unknown>
): Promise<TResult> {
  const traced = Telemetry.withActiveParent(
    Telemetry.spanPromise(name, run, attributes ? { attributes } : undefined)
  )
  return runtime ? runtime.runPromise(traced) : Effect.runPromise(traced)
}

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
