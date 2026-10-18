import * as Telemetry from "@workspace/telemetry"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { Fiber, Tracer } from "effect"

import type { AppCache } from "./cache"
import { AppCacheLive } from "./cache"
import type { Database } from "./database"
import { DatabaseLive } from "./database"
import { loadedKilnInstallationId } from "./installation"
import { isExpectedAppError } from "../observability/error-policy"

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

const AppLive = Layer.mergeAll(DatabaseLive, AppCacheLive, TelemetryLive)
const runtime = ManagedRuntime.make(AppLive)

/** Runtime-owned workers span individual jobs, rather than their lifetime. */
export function forkAppWorker(
  effect: Effect.Effect<void, never, AppCache | Database>
) {
  return runtime.runFork(effect)
}

export function runAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppCache | Database>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  return runtime.runPromise(
    Telemetry.withActiveParent(Effect.withSpan(effect, name)),
    options
  )
}

export function forkAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppCache | Database>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(effect.pipe(Effect.withSpan(name)))
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
