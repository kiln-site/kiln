import { Effect, Fiber, Stream } from "effect"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

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

import {
  openRelayResourceStream,
  warmHistoryOnce,
} from "./relay-resource-stream"
import { RelayBrowserReconnectError } from "./authenticated-relay-socket"

beforeEach(() => vi.clearAllMocks())

describe("resource stream lifecycle", () => {
  it("reconnects a lost renewal acknowledgement without switching to polling", async () => {
    fakes.open
      .mockReturnValueOnce(
        Effect.fail(new RelayBrowserReconnectError("ack lost"))
      )
      .mockImplementation(() =>
        Effect.acquireRelease(
          Effect.succeed({
            ready: {},
            socket: { send: fakes.send },
            inbox: { stream: Stream.never },
          }),
          () => Effect.sync(fakes.close)
        )
      )
    const fiber = Effect.runFork(
      openRelayResourceStream("relay", "instance").pipe(Stream.runDrain)
    )
    await vi.waitFor(() => expect(fakes.send).toHaveBeenCalledOnce())
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fakes.open).toHaveBeenCalledTimes(2)
    expect(fakes.poll).not.toHaveBeenCalled()
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(fakes.release).toHaveBeenCalledOnce()
  })

  it("releases a silent socket immediately on consumer interruption", async () => {
    fakes.open.mockImplementation(() =>
      Effect.acquireRelease(
        Effect.succeed({
          ready: {},
          socket: { send: fakes.send },
          inbox: { stream: Stream.never },
        }),
        () => Effect.sync(fakes.close)
      )
    )
    const fiber = Effect.runFork(
      openRelayResourceStream("relay", "instance").pipe(Stream.runDrain)
    )
    await vi.waitFor(() => expect(fakes.send).toHaveBeenCalledOnce())
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(fakes.release).toHaveBeenCalledOnce()
    expect(fakes.poll).not.toHaveBeenCalled()
  })

  it("falls back on direct setup failure and aborts an in-flight poll on teardown", async () => {
    fakes.open.mockReturnValue(
      Effect.fail(new Error("Direct endpoint unavailable"))
    )
    let pollSignal: AbortSignal | undefined
    fakes.poll.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      pollSignal = signal
      return new Promise(() => {})
    })
    const fiber = Effect.runFork(
      openRelayResourceStream("relay", "instance").pipe(Stream.runDrain)
    )
    await vi.waitFor(() => expect(fakes.poll).toHaveBeenCalledOnce())
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(pollSignal?.aborted).toBe(true)
    expect(fakes.release).toHaveBeenCalledOnce()
  })
})

describe("Hearth resource polling", () => {
  it("delivers warm history only with the first poll", () => {
    const historyForPoll = warmHistoryOnce<number>()

    expect(historyForPoll([1, 2, 3])).toEqual([1, 2, 3])
    expect(historyForPoll([1, 2, 3, 4])).toEqual([])
    expect(historyForPoll([5])).toEqual([])
  })
})
