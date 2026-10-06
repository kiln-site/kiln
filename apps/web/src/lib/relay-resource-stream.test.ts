import { assert, describe, it } from "@effect/vitest"
import { relayInstanceSchema } from "@workspace/contracts"
import { Effect, Fiber, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { beforeEach, vi } from "vite-plus/test"

const fakes = vi.hoisted(() => ({
  open: vi.fn(),
  poll: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
}))
vi.mock("@/lib/authenticated-relay-socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authenticated-relay-socket")>()),
  openAuthenticatedRelaySocket: (...args: unknown[]) => fakes.open(...args),
}))
vi.mock("@/server/relay", () => ({
  getRelayInstanceResources: (...args: unknown[]) => fakes.poll(...args),
}))
vi.mock("@/lib/relay-browser-credentials", () => ({
  acquireRelayBrowserCredentials: () => ({
    credentials: Promise.resolve({ keys: {}, publicKeyJwk: {} }),
    issue: () =>
      Promise.resolve({
        capability: "cap",
        browserOrigin: "https://relay.test",
        proxyMode: "none",
        version: 1,
      }),
    onAuthorizationChange: () => () => undefined,
    release: fakes.release,
  }),
}))

import { openRelayResourceStream } from "./relay-resource-stream"
import { RelayBrowserReconnectError } from "./authenticated-relay-socket"

beforeEach(() => vi.clearAllMocks())

// Credential and poll promises settle outside virtual time, so advance the
// TestClock in small steps until the expected outcome has happened.
const advanceUntil = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let step = 0; step < 100 && !done(); step++) {
      yield* TestClock.adjust(100)
    }
    assert.isTrue(done())
  })

const silentSocket = () =>
  Effect.acquireRelease(
    Effect.succeed({
      ready: {},
      socket: { send: fakes.send },
      inbox: { stream: Stream.never },
    }),
    () => Effect.sync(fakes.close)
  )

const sample = {
  sampledAt: "2026-10-05T00:00:00.000Z",
  cpu: { percent: 5 },
  memory: { totalBytes: 100, usedBytes: 10, percent: 10 },
  storage: { totalBytes: 100, usedBytes: 10, percent: 10 },
}
const instance = relayInstanceSchema.parse({
  id: "a".repeat(40),
  shortId: "a".repeat(8),
  name: "Resources",
  game: "Minecraft",
  implementation: "Paper",
  version: "1.21.11",
  javaVersion: "21",
  connectAddress: "resources.test",
  service: "resources",
  directory: "/srv/resources",
  desiredState: "running",
  observedState: "running",
  containerId: "container",
  status: "Running",
})

describe("resource stream lifecycle", () => {
  it.effect(
    "releases credentials without polling or retrying a permission denial",
    () =>
      Effect.gen(function* () {
        fakes.open.mockReturnValue(Effect.fail(new Error("Permission denied")))

        const result = yield* openRelayResourceStream("relay", "instance").pipe(
          Stream.runDrain,
          Effect.result
        )

        assert.strictEqual(result._tag, "Failure")
        assert.strictEqual(fakes.open.mock.calls.length, 1)
        assert.strictEqual(fakes.release.mock.calls.length, 1)
        assert.strictEqual(fakes.poll.mock.calls.length, 0)
      })
  )

  it.effect(
    "reconnects a lost renewal acknowledgement without switching to polling",
    () =>
      Effect.gen(function* () {
        fakes.open
          .mockReturnValueOnce(
            Effect.fail(new RelayBrowserReconnectError("ack lost"))
          )
          .mockImplementation(silentSocket)

        const fiber = yield* openRelayResourceStream("relay", "instance").pipe(
          Stream.runDrain,
          Effect.forkChild
        )
        yield* advanceUntil(() => fakes.send.mock.calls.length === 1)
        yield* Fiber.interrupt(fiber)

        assert.strictEqual(fakes.open.mock.calls.length, 2)
        assert.strictEqual(fakes.poll.mock.calls.length, 0)
        assert.strictEqual(fakes.close.mock.calls.length, 1)
        assert.strictEqual(fakes.release.mock.calls.length, 1)
      })
  )

  it.effect(
    "releases a silent socket immediately on consumer interruption",
    () =>
      Effect.gen(function* () {
        fakes.open.mockImplementation(silentSocket)

        const fiber = yield* openRelayResourceStream("relay", "instance").pipe(
          Stream.runDrain,
          Effect.forkChild
        )
        yield* advanceUntil(() => fakes.send.mock.calls.length === 1)
        yield* Fiber.interrupt(fiber)

        assert.strictEqual(fakes.close.mock.calls.length, 1)
        assert.strictEqual(fakes.release.mock.calls.length, 1)
        assert.strictEqual(fakes.poll.mock.calls.length, 0)
      })
  )

  it.effect(
    "falls back on direct setup failure and aborts an in-flight poll on teardown",
    () =>
      Effect.gen(function* () {
        fakes.open.mockReturnValue(
          Effect.fail(new Error("Direct endpoint unavailable"))
        )
        let pollSignal: AbortSignal | undefined
        fakes.poll.mockImplementation(({ signal }: { signal: AbortSignal }) => {
          pollSignal = signal
          return new Promise(() => {})
        })

        const fiber = yield* openRelayResourceStream("relay", "instance").pipe(
          Stream.runDrain,
          Effect.forkChild
        )
        yield* advanceUntil(() => pollSignal !== undefined)
        yield* Fiber.interrupt(fiber)

        assert.isTrue(pollSignal?.aborted)
        assert.strictEqual(fakes.release.mock.calls.length, 1)
      })
  )
})

describe("Hearth resource polling", () => {
  it.effect("delivers warm history only with the first poll", () =>
    Effect.gen(function* () {
      fakes.open.mockReturnValue(
        Effect.fail(new Error("Direct endpoint unavailable"))
      )
      fakes.poll.mockResolvedValue({ history: [sample, sample], instance })

      const fiber = yield* openRelayResourceStream("relay", "instance").pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* advanceUntil(() => fiber.pollUnsafe() !== undefined)
      const events = yield* Fiber.join(fiber)

      assert.deepStrictEqual(
        events.map((event) => event.history.length),
        [2, 0]
      )
    })
  )
})
