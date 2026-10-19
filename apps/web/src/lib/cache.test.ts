import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { AppCache } from "@/effect/cache"
import { CacheError } from "@/effect/errors"

import { readThroughCache } from "./cache"

const policy = { key: "example", name: "Example", ttlMs: 1_000 }
const fallbackPolicy = { ...policy, fallbackTtlMs: 60_000 }
const fallbackKey = `${policy.key}:last-known`

function decodeString(input: unknown): string {
  if (typeof input !== "string") throw new Error("Expected a string")
  return input
}

function testCache(options?: { fail?: boolean; initial?: string }) {
  const values = new Map<string, string>()
  if (options?.initial !== undefined) values.set(policy.key, options.initial)
  const failure = CacheError.make({
    operation: "TEST",
    cause: new Error("Cache unavailable"),
  })
  const layer = Layer.succeed(AppCache)({
    backend: "redis-protocol",
    enabled: true,
    get: (key) =>
      options?.fail ? Effect.fail(failure) : Effect.succeed(values.get(key)),
    remove: (key) => {
      if (options?.fail) return Effect.fail(failure)
      values.delete(key)
      return Effect.void
    },
    set: (key, value) => {
      if (options?.fail) return Effect.fail(failure)
      values.set(key, value)
      return Effect.void
    },
  })
  return { layer, values }
}

describe("readThroughCache", () => {
  it.effect("evicts corrupt data and replaces it from the source", () => {
    const cache = testCache({ initial: "not-json" })
    return Effect.gen(function* () {
      const result = yield* readThroughCache({
        decode: decodeString,
        load: Effect.succeed("fresh"),
        policy,
      })
      assert.strictEqual(result, "fresh")
      assert.strictEqual(cache.values.get(policy.key), JSON.stringify("fresh"))
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("fails open when the cache is unavailable", () => {
    const cache = testCache({ fail: true })
    return Effect.gen(function* () {
      const result = yield* readThroughCache({
        decode: decodeString,
        load: Effect.succeed("source"),
        policy,
      })
      assert.strictEqual(result, "source")
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("returns last-known data when the source is unavailable", () => {
    const cache = testCache()
    cache.values.set(fallbackKey, JSON.stringify("last-known"))
    return Effect.gen(function* () {
      const result = yield* readThroughCache({
        decode: decodeString,
        fallbackOnError: true,
        load: Effect.fail("Relay unavailable"),
        policy: fallbackPolicy,
      })
      assert.strictEqual(result, "last-known")
      assert.strictEqual(cache.values.has(policy.key), false)
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("updates fresh and last-known data after a source load", () => {
    const cache = testCache()
    return Effect.gen(function* () {
      const result = yield* readThroughCache({
        decode: decodeString,
        fallbackOnError: true,
        load: Effect.succeed("fresh"),
        policy: fallbackPolicy,
      })
      assert.strictEqual(result, "fresh")
      assert.strictEqual(cache.values.get(policy.key), JSON.stringify("fresh"))
      assert.strictEqual(cache.values.get(fallbackKey), JSON.stringify("fresh"))
    }).pipe(Effect.provide(cache.layer))
  })
})
