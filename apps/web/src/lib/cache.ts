import { Clock, Effect, Exit, Option, Result, Schema, Scope } from "effect"

import { AppCache } from "@/effect/cache"
import type { CacheError } from "@/effect/errors"

export interface CachePolicy {
  fallbackTtlMs?: number
  key: string
  name: string
  ttlMs: number
}

interface ReadThroughCacheOptions<TResult, TError, TRequirements> {
  bypass?: boolean
  decode: (input: unknown) => TResult
  fallbackOnError?: boolean
  load: Effect.Effect<TResult, TError, TRequirements>
  policy: CachePolicy
}

const cacheWarningIntervalMs = 60_000
let lastCacheWarningAt = 0

export const readThroughCache = Effect.fn("cache.readThrough")(function* <
  TResult,
  TError,
  TRequirements,
>(options: ReadThroughCacheOptions<TResult, TError, TRequirements>) {
  const cache = yield* AppCache
  if (!cache.enabled) return yield* options.load
  if (options.bypass) {
    const value = yield* options.load
    yield* writeCachedJson(options.policy, value)
    return value
  }

  const cached = yield* readCachedJson(options.policy, options.decode)
  if (Option.isSome(cached)) return cached.value

  if (options.fallbackOnError && options.policy.fallbackTtlMs) {
    const loaded = yield* Effect.result(options.load)
    if (Result.isSuccess(loaded)) {
      yield* writeCachedJson(options.policy, loaded.success)
      return loaded.success
    }
    const fallback = yield* readCachedJson(
      fallbackPolicy(options.policy),
      options.decode
    )
    if (Option.isSome(fallback)) return fallback.value
    return yield* Effect.fail(loaded.failure)
  }

  const value = yield* options.load
  yield* writeCachedJson(options.policy, value)
  return value
})

export interface WarmCachePolicy {
  // How long a value is served without refreshing it.
  freshMs: number
  key: string
  name: string
  // How long a value is kept, to be served while it refreshes.
  ttlMs: number
}

interface WarmCacheOptions<TResult, TError, TRequirements> {
  decode: (input: unknown) => TResult
  load: Effect.Effect<TResult, TError, TRequirements>
  // A value to serve when nothing is cached and the load fails, such as one
  // kept under an older key. It is not stored, so the next read loads again.
  lastKnown?: Effect.Effect<TResult | undefined, never, TRequirements>
  policy: WarmCachePolicy
}

const WarmEntrySchema = Schema.Struct({
  storedAt: Schema.Number,
  value: Schema.Unknown,
})
const decodeWarmEntry = Schema.decodeUnknownSync(WarmEntrySchema)

// Keys this process is refreshing, so a refresh starts once however many
// readers find the value stale.
const warmRefreshes = new Set<string>()
// Refreshes outlive the request that started them, but not Hearth: shutdown
// closes this scope before the cache and telemetry they write through.
const warmRefreshScope = Scope.makeUnsafe()

/** Interrupts background refreshes still running, for shutdown. */
export const stopWarmCacheRefreshes: Effect.Effect<void> = Scope.close(
  warmRefreshScope,
  Exit.void
)

/**
 * Serves a cached value at once, however old, and refreshes one that is past
 * `freshMs` in the background, so only the first read of a value waits for
 * its source. A failed refresh keeps the value it would have replaced.
 */
export const readWarmCache = Effect.fn("cache.readWarm")(function* <
  TResult,
  TError,
  TRequirements,
>(options: WarmCacheOptions<TResult, TError, TRequirements>) {
  const cache = yield* AppCache
  if (!cache.enabled) return yield* options.load
  const { policy } = options
  const cached = yield* readCachedJson(
    { key: policy.key, name: policy.name, ttlMs: policy.ttlMs },
    (input) => {
      const entry = decodeWarmEntry(input)
      return { storedAt: entry.storedAt, value: options.decode(entry.value) }
    }
  )
  if (Option.isNone(cached)) {
    const loaded = yield* Effect.result(storeWarm(options))
    if (Result.isSuccess(loaded)) return loaded.success
    // Served, never stored: another reader may have stored a newer value.
    const lastKnown = options.lastKnown ? yield* options.lastKnown : undefined
    if (lastKnown === undefined) return yield* Effect.fail(loaded.failure)
    return lastKnown
  }

  const now = yield* Clock.currentTimeMillis
  if (
    now - cached.value.storedAt >= policy.freshMs &&
    !warmRefreshes.has(policy.key)
  ) {
    warmRefreshes.add(policy.key)
    yield* storeWarm(options).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not refresh a cached value; keeping it", {
          cache: policy.name,
          error,
        })
      ),
      Effect.ensuring(Effect.sync(() => warmRefreshes.delete(policy.key))),
      Effect.forkIn(warmRefreshScope)
    )
  }
  return cached.value.value
})

const storeWarm = Effect.fnUntraced(function* <TResult, TError, TRequirements>(
  options: WarmCacheOptions<TResult, TError, TRequirements>
) {
  const value = yield* options.load
  const storedAt = yield* Clock.currentTimeMillis
  yield* writeCachedJson(
    {
      key: options.policy.key,
      name: options.policy.name,
      ttlMs: options.policy.ttlMs,
    },
    { storedAt, value }
  )
  return value
})

export const invalidateCached = Effect.fn("cache.invalidate")(function* (
  policy: CachePolicy
) {
  const cache = yield* AppCache
  if (!cache.enabled) return
  yield* ignoreCacheFailure(policy.name, cache.remove(policy.key))
  if (policy.fallbackTtlMs) {
    yield* ignoreCacheFailure(
      policy.name,
      cache.remove(fallbackPolicy(policy).key)
    )
  }
})

export const readCachedFallback = Effect.fn("cache.readFallback")(function* <
  TResult,
>(policy: CachePolicy, decode: (input: unknown) => TResult) {
  const cache = yield* AppCache
  if (!cache.enabled || !policy.fallbackTtlMs) return undefined
  const cached = yield* readCachedJson(fallbackPolicy(policy), decode)
  return Option.getOrUndefined(cached)
})

export const writeCachedJson = Effect.fn("cache.write")(function* <TValue>(
  policy: CachePolicy,
  value: TValue
) {
  const cache = yield* AppCache
  if (!cache.enabled) return
  const encoded = yield* Effect.option(
    Effect.try({
      try: (): unknown => JSON.stringify(value),
      catch: (cause) => cause,
    })
  )
  if (Option.isNone(encoded) || typeof encoded.value !== "string") return
  yield* ignoreCacheFailure(
    policy.name,
    cache.set(policy.key, encoded.value, policy.ttlMs)
  )
  if (policy.fallbackTtlMs) {
    yield* ignoreCacheFailure(
      policy.name,
      cache.set(fallbackPolicy(policy).key, encoded.value, policy.fallbackTtlMs)
    )
  }
})

const readCachedJson = Effect.fn("cache.readJson")(function* <TResult>(
  policy: CachePolicy,
  decode: (input: unknown) => TResult
) {
  const cache = yield* AppCache
  const cached = yield* cache
    .get(policy.key)
    .pipe(
      Effect.catch((error) =>
        warnCacheFailure(policy.name, error).pipe(Effect.as(undefined))
      )
    )
  if (cached === undefined) return Option.none<TResult>()

  const decoded = yield* Effect.option(
    Effect.try({
      try: () => {
        const parsed: unknown = JSON.parse(cached)
        return decode(parsed)
      },
      catch: (cause) => cause,
    })
  )
  if (Option.isSome(decoded)) return decoded
  yield* ignoreCacheFailure(policy.name, cache.remove(policy.key))
  return Option.none<TResult>()
})

function fallbackPolicy(policy: CachePolicy): CachePolicy {
  return {
    key: `${policy.key}:last-known`,
    name: `${policy.name} last-known fallback`,
    ttlMs: policy.fallbackTtlMs ?? policy.ttlMs,
  }
}

function ignoreCacheFailure<TResult>(
  name: string,
  effect: Effect.Effect<TResult, CacheError>
): Effect.Effect<void> {
  return effect.pipe(
    Effect.asVoid,
    Effect.catch((error) => warnCacheFailure(name, error))
  )
}

function warnCacheFailure(
  name: string,
  error: CacheError
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const now = Date.now()
    if (now - lastCacheWarningAt < cacheWarningIntervalMs) return Effect.void
    lastCacheWarningAt = now
    return Effect.logWarning(
      "Distributed cache unavailable; using source data",
      {
        cache: name,
        error: error.message,
      }
    )
  })
}
