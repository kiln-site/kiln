import { Effect, Option, Result } from "effect"

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
