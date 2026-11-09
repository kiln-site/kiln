import { assert, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeEach, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { loadPersistedRelay } from "@/lib/relay-registry"
import { tryRelayPublicRoute } from "@/server/relay-public-route.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

const relayId = "1".repeat(12)
const relayHost = "203.0.113.7"

// The Relay and the public route are the network boundaries: the Relay takes
// each trial step, and the route answers what the test says it does.
const relay = vi.hoisted(() => ({
  answer: "",
  steps: [] as Array<string>,
}))
const route = vi.hoisted(() => ({
  read: (_url: URL, _answer: string): string | null => null,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    _operation: string,
    payload: { answer?: string; step: string }
  ) => {
    relay.steps.push(payload.step)
    if (payload.answer) relay.answer = payload.answer
    return { problem: null }
  },
}))

vi.mock("@/lib/relay-route-read.server", () => ({
  readRelayRoute: async (url: URL) => route.read(url, relay.answer),
}))

afterAll(() => disposeAppRuntime())

beforeEach(() => {
  relay.answer = ""
  relay.steps = []
  route.read = () => null
})

const tryRoute = Effect.fnUntraced(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId, {
    browser_origin: `https://${relayHost}:4100`,
    hostname: relayHost,
    port: 4100,
  })
  const saved = yield* Effect.promise(() => loadPersistedRelay(relayId))
  if (!saved) return yield* Effect.die("The Relay wasn't saved")
  const running = yield* Effect.forkChild(
    tryRelayPublicRoute(saved, { automatic: true })
  )
  // Its database write is real I/O, so time passes only as it waits.
  while (!running.pollUnsafe()) {
    yield* TestClock.adjust("2 seconds")
    yield* Effect.promise(() => new Promise(setImmediate))
  }
  return yield* Fiber.join(running)
})

describeMysql("Looking for a Relay's public route", () => {
  layer(TestDatabase)((it) => {
    it.effect("moves the Relay once its route works end to end", () =>
      Effect.gen(function* () {
        route.read = (_url, answer) => answer

        const outcome = yield* tryRoute()

        assert.strictEqual(outcome.status, "direct")
        assert.deepStrictEqual(relay.steps, ["start", "certificate", "commit"])
      })
    )

    it.effect(
      "leaves the Relay alone when port 80 leads to another machine",
      () =>
        Effect.gen(function* () {
          route.read = () => "404 from the machine that has the port"

          const outcome = yield* tryRoute()

          assert.strictEqual(outcome.status, "through-hearth")
          assert.deepStrictEqual(relay.steps, ["start", "stop"])
        })
    )
  })
})
