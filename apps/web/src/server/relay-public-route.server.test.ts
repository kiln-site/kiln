import { assert, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeEach, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import {
  loadPersistedRelay,
  rememberRelayBrowserOrigin,
} from "@/lib/relay-registry"
import { tryRelayPublicRoute } from "@/server/relay-public-route.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

const relayId = "r".repeat(43)
const relayHost = "203.0.113.7"

// The Relay and the public route are the network boundaries: the Relay takes
// each trial step, and the route answers what the test says it does.
const relay = vi.hoisted(() => ({
  answer: "",
  problems: {} as Partial<Record<string, string>>,
  steps: [] as Array<string>,
}))
const route = vi.hoisted(() => ({
  read: (_url: URL, _answer: string): string | null => null,
  reads: [] as Array<string>,
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
    return { problem: relay.problems[payload.step] ?? null }
  },
}))

vi.mock("@/lib/relay-route-read.server", () => ({
  readRelayRoute: async (url: URL) => {
    route.reads.push(url.protocol)
    return route.read(url, relay.answer)
  },
}))

afterAll(() => disposeAppRuntime())

beforeEach(() => {
  relay.answer = ""
  relay.problems = {}
  relay.steps = []
  route.read = () => null
  route.reads = []
})

const tryRoute = Effect.fnUntraced(function* (hostname = relayHost) {
  yield* resetDatabase
  yield* insertRelay(relayId, {
    browser_origin: `https://${hostname}:4100`,
    hostname,
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

    it.effect(
      "ends the trial when no certificate comes, and keeps the Relay as it was",
      () =>
        Effect.gen(function* () {
          route.read = (url, answer) =>
            url.protocol === "http:" ? answer : null

          const outcome = yield* tryRoute()

          assert.strictEqual(outcome.status, "through-hearth")
          assert.deepStrictEqual(relay.steps, ["start", "certificate", "stop"])
        })
    )

    it.effect("gives way when the Relay can't try", () =>
      Effect.gen(function* () {
        relay.problems = { start: "Port 80 is in use." }

        const outcome = yield* tryRoute()

        assert.deepStrictEqual(outcome, {
          reason: "Port 80 is in use.",
          status: "through-hearth",
        })
        assert.deepStrictEqual(relay.steps, ["start"])
        assert.deepStrictEqual(route.reads, [])
      })
    )

    // A Relay can move while Hearth is away, which leaves only its report.
    it.effect("follows where a connected Relay says browsers reach it", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId, {
          browser_origin: `https://${relayHost}:4100`,
        })

        yield* Effect.promise(() =>
          rememberRelayBrowserOrigin(relayId, `https://${relayHost}`)
        )

        const [row] = yield* selectRows<{ browser_origin: string }>("relay")
        assert.strictEqual(row?.browser_origin, `https://${relayHost}`)
      })
    )

    it.effect("doesn't try an address the internet can't reach", () =>
      Effect.gen(function* () {
        const outcome = yield* tryRoute("192.168.1.20")

        assert.strictEqual(outcome.status, "through-hearth")
        assert.deepStrictEqual(relay.steps, [])
      })
    )
  })
})
