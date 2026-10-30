import * as Telemetry from "@workspace/telemetry"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { Fiber, Tracer } from "effect"

import type { AppCache } from "./cache"
import { AppCacheLive } from "./cache"
import type { Database } from "./database"
import { DatabaseLive } from "./database"
import { loadedKilnInstallationId } from "./installation"
import {
  OperationsEngineLive,
  type OperationsEngineService,
} from "../operations/engine-service"
import { isExpectedAppError } from "../observability/error-policy"
import { inCurrentOperation } from "../operations/current"

declare const __KILN_TELEMETRY_DEFAULTS__: Telemetry.TelemetryDefaults

// Baked at build time from the release's OTEL_* variables. The environment
// overrides them.
export const telemetryDefaults: Telemetry.TelemetryDefaults =
  typeof __KILN_TELEMETRY_DEFAULTS__ === "undefined"
    ? {}
    : __KILN_TELEMETRY_DEFAULTS__

const sourceCommit = import.meta.env.VITE_KILN_SOURCE_SHA
// Built on first use, which startup holds back until the installation ID is
// loaded.
const TelemetryLive = Layer.unwrap(
  Effect.sync(() => {
    const installationId = loadedKilnInstallationId()
    return Telemetry.layer(
      {
        serviceName: "hearth",
        serviceVersion: import.meta.env.VITE_KILN_VERSION,
        attributes: {
          ...(sourceCommit ? { "vcs.ref.head.revision": sourceCommit } : {}),
          ...(installationId ? { "kiln.installation_id": installationId } : {}),
        },
      },
      telemetryDefaults
    )
  })
)

/** What every effect run on Hearth's runtime may use. */
export type AppServices = AppCache | Database | OperationsEngineService

const ServicesLive = Layer.mergeAll(DatabaseLive, AppCacheLive)
const AppLive = Layer.mergeAll(
  OperationsEngineLive.pipe(Layer.provideMerge(ServicesLive)),
  TelemetryLive
)
const runtime = ManagedRuntime.make(AppLive)

/** Runtime-owned workers span individual jobs, rather than their lifetime. */
export function forkAppWorker(effect: Effect.Effect<void, never, AppServices>) {
  return runtime.runFork(effect)
}

export async function runAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  const exit = await runtime.runPromiseExit(
    inCurrentOperation(
      Telemetry.withActiveParent(Effect.withSpan(effect, name))
    ),
    options
  )
  if (Exit.isSuccess(exit)) return exit.value
  // Stopped only because whoever asked gave up, as a browser does when it
  // leaves the page: an abort, which isn't reported, rather than a failure.
  // Anything that went wrong as well is still thrown and reported.
  if (options?.signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) {
    throw new DOMException("The request was aborted", "AbortError")
  }
  throw Cause.squash(exit.cause)
}

/** Runs a background check, such as a worker's idle poll, without tracing it. */
export function runAppEffectUntraced<TResult, TError>(
  effect: Effect.Effect<TResult, TError, AppServices>
): Promise<TResult> {
  return runtime.runPromise(
    inCurrentOperation(Effect.withTracerEnabled(effect, false))
  )
}

export function forkAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(effect.pipe(Effect.withSpan(name)))
}

/**
 * Forks work a request starts but doesn't wait for, such as its audit
 * writes, into that request's trace.
 */
export function forkAppEffectInTrace<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(
    Telemetry.withActiveParent(effect.pipe(Effect.withSpan(name)))
  )
}

/** Traces promise code; effects it runs become child spans. */
export function traceAppPromise<TResult>(
  name: string,
  run: (span: Tracer.Span) => Promise<TResult>,
  attributes?: Record<string, unknown>
): Promise<TResult> {
  return runtime.runPromise(
    Telemetry.withActiveParent(
      Telemetry.spanPromise(name, run, attributes ? { attributes } : undefined)
    )
  )
}

/**
 * Exports an unexpected error as an error log. Expected outcomes such as
 * failed authentication or a missing resource are skipped.
 */
export function reportAppError(
  cause: unknown,
  context?: Telemetry.ErrorContext
): void {
  if (isExpectedAppError(cause)) return
  runtime.runFork(
    Telemetry.withActiveParent(Telemetry.logException(cause, context))
  )
}

export async function disposeAppRuntime(): Promise<void> {
  await runtime.dispose()
}
