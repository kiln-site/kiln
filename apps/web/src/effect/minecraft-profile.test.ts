import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import { resolveMinecraftProfileEffect } from "./minecraft-profile"

describe("Minecraft profile lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("skips display names that cannot be Minecraft usernames", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      const profile = yield* resolveMinecraftProfileEffect("Kiln Developer")

      assert.isNull(profile)
      assert.strictEqual(fetchMock.mock.calls.length, 0)
    })
  })

  it.effect("resolves a Minecraft profile through Mojang", () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          id: "069a79f444e94726a5befca90e38aaf5",
          name: "Notch",
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      const profile = yield* resolveMinecraftProfileEffect("Notch")

      assert.deepEqual(profile, {
        id: "069a79f444e94726a5befca90e38aaf5",
        name: "Notch",
      })
      assert.strictEqual(fetchMock.mock.calls.length, 1)
      assert.strictEqual(
        fetchMock.mock.calls[0]?.[0],
        "https://api.mojang.com/users/profiles/minecraft/Notch"
      )
    })
  })

  it.effect("treats a missing Minecraft profile as a normal fallback", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      const profile = yield* resolveMinecraftProfileEffect("Kiln")

      assert.isNull(profile)
      assert.strictEqual(fetchMock.mock.calls.length, 1)
    })
  })

  it.effect("fails when Mojang returns a transient HTTP error", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      const failure = yield* resolveMinecraftProfileEffect("Notch").pipe(
        Effect.flip
      )

      assert.strictEqual(failure._tag, "ExternalServiceError")
      assert.strictEqual(failure.service, "Mojang")
      assert.strictEqual(failure.message, "Mojang returned HTTP 503")
    })
  })

  it.effect("fails when Mojang returns an invalid profile", () => {
    const fetchMock = vi.fn(async () => Response.json({ name: "Notch" }))
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      const failure = yield* resolveMinecraftProfileEffect("Notch").pipe(
        Effect.flip
      )

      assert.strictEqual(failure._tag, "ExternalServiceError")
      assert.strictEqual(failure.service, "Mojang")
    })
  })
})
