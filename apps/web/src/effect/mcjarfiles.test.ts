import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { listMcJarVersionsEffect } from "@/effect/mcjarfiles"

const key = "mcjarfiles:versions:servers:paper"

function memoryCache(initial: Record<string, unknown>) {
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
  return { layer, values }
}

function mcjarfilesResponds(body: unknown) {
  vi.stubGlobal("fetch", async () => Response.json(body))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Minecraft version catalog", () => {
  it.effect("keeps the last-known list when mcjarfiles lists none", () => {
    const cache = memoryCache({
      [`${key}:last-known`]: { versions: ["1.21.11", "1.21.10"] },
    })
    mcjarfilesResponds([" ", ""])
    return Effect.gen(function* () {
      const catalog = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["1.21.11", "1.21.10"])
      assert.deepStrictEqual(
        JSON.parse(cache.values.get(`${key}:last-known`) ?? "null"),
        { versions: ["1.21.11", "1.21.10"] }
      )
    }).pipe(Effect.provide(cache.layer))
  })

  it.effect("refetches instead of serving a cached empty list", () => {
    const cache = memoryCache({ [key]: { versions: [] } })
    mcjarfilesResponds(["26.3", "26.3", "1.21.11"])
    return Effect.gen(function* () {
      const catalog = yield* listMcJarVersionsEffect("servers", "paper")

      assert.deepStrictEqual(catalog.versions, ["26.3", "1.21.11"])
    }).pipe(Effect.provide(cache.layer))
  })
})
