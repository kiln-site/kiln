import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { afterEach, expect, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { listMcJarVersionsEffect } from "@/effect/mcjarfiles"

const key = "mcjarfiles:versions:v2:servers:paper"
const freshMs = 30 * 60_000

function memoryCache(initial: Record<string, unknown> = {}) {
  const values = new Map(
    Object.entries(initial).map(([name, value]) => [
      name,
      JSON.stringify(value),
    ])
  )
  const layer = Layer.succeed(AppCache)({
    backend: "redis-protocol",
    enabled: true,
    get: (name) => Effect.succeed(values.get(name)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
  })
  const stored = () => JSON.parse(values.get(key) ?? "null")
  return { layer, stored }
}

// mcjarfiles is the network boundary; each test decides what it lists.
function mcjarfilesLists(versions: unknown) {
  const fetch = vi.fn(async () => Response.json(versions))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Minecraft version catalog", () => {
  it.effect("reads mcjarfiles once when nothing is cached", () => {
    const cache = memoryCache()
    const fetch = mcjarfilesLists(["26.3", "26.3", " 1.21.11 "])
    return Effect.gen(function* () {
      const catalog = yield* listMcJarVersionsEffect("servers", "paper")
      const again = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["26.3", "1.21.11"])
      assert.deepStrictEqual(again.versions, ["26.3", "1.21.11"])
      expect(fetch).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect(
    "serves a stale list at once and refreshes it in the background",
    () => {
      const cache = memoryCache({
        [key]: { storedAt: 0, value: { versions: ["1.21.10"] } },
      })
      const fetch = mcjarfilesLists(["1.21.11", "1.21.10"])
      return Effect.gen(function* () {
        yield* TestClock.adjust(freshMs)

        // Several readers find it stale; one refresh serves them all.
        const catalogs = yield* Effect.all(
          [1, 2, 3].map(() => listMcJarVersionsEffect("servers", "paper")),
          { concurrency: "unbounded" }
        )

        for (const catalog of catalogs)
          assert.deepStrictEqual(catalog.versions, ["1.21.10"])
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(cache.stored()).toMatchObject({
              value: { versions: ["1.21.11", "1.21.10"] },
            })
          )
        )
        expect(fetch).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(cache.layer))
    }
  )

  it.effect("serves a fresh list without asking mcjarfiles", () => {
    const cache = memoryCache({
      [key]: { storedAt: 0, value: { versions: ["1.21.11"] } },
    })
    const fetch = mcjarfilesLists(["26.3"])
    return Effect.gen(function* () {
      yield* TestClock.adjust(freshMs - 1)

      const catalog = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["1.21.11"])
      expect(fetch).not.toHaveBeenCalled()
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("keeps the cached list when a refresh lists no versions", () => {
    const cache = memoryCache({
      [key]: { storedAt: 0, value: { versions: ["1.21.11", "1.21.10"] } },
    })
    const fetch = mcjarfilesLists([" ", ""])
    return Effect.gen(function* () {
      yield* TestClock.adjust(freshMs)

      const catalog = yield* listMcJarVersionsEffect("servers", "paper")
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      )
      const again = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["1.21.11", "1.21.10"])
      assert.deepStrictEqual(again.versions, ["1.21.11", "1.21.10"])
      expect(cache.stored()).toMatchObject({
        value: { versions: ["1.21.11", "1.21.10"] },
      })
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("refetches instead of serving a cached empty list", () => {
    const cache = memoryCache({
      [key]: { storedAt: 0, value: { versions: [] } },
    })
    mcjarfilesLists(["26.3", "1.21.11"])
    return Effect.gen(function* () {
      const catalog = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["26.3", "1.21.11"])
    }).pipe(Effect.provide(cache.layer))
  })
})
