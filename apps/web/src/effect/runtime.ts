import * as Sentry from "@sentry/tanstackstart-react"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { Fiber } from "effect"

import type { AppCache } from "./cache"
import { AppCacheLive } from "./cache"
import type { Database } from "./database"
import { DatabaseLive } from "./database"

const AppLive = Layer.mergeAll(DatabaseLive, AppCacheLive)
const runtime = ManagedRuntime.make(AppLive)

export function runAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppCache | Database>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  return Sentry.startSpan({ name, op: "kiln.effect" }, () =>
    runtime.runPromise(effect, options)
  )
}

export function forkAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppCache | Database>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(effect.pipe(Effect.withSpan(name)))
}

export async function disposeAppRuntime(): Promise<void> {
  await runtime.dispose()
}
