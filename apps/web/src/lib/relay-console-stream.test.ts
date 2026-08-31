import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect, Fiber, Queue, Stream } from "effect"

const relayCapability = vi.hoisted(() => ({
  issue: vi.fn(),
}))

vi.mock("@/server/relay-capability", () => ({
  issueConsoleCapability: relayCapability.issue,
}))

import {
  createSocketInbox,
  openRelayConsoleStream,
} from "./relay-console-stream"

afterEach(() => {
  relayCapability.issue.mockReset()
  FakeWebSocket.instances.length = 0
  vi.unstubAllGlobals()
})

describe("Relay console connection setup", () => {
  it("opens the socket early but waits for capability before authenticating", async () => {
    let resolveCapability: (value: {
      browserOrigin: string
      capability: string
      expiresAt: number
      proxyMode: "none"
      relayId: string
    }) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)

    const running = Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://relay.example.com"
      ).pipe(Stream.runHead)
    )

    await vi.waitFor(() => {
      expect(relayCapability.issue).toHaveBeenCalledOnce()
      expect(FakeWebSocket.instances).toHaveLength(1)
    })
    const socket = FakeWebSocket.instances[0]
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          expiresAt: Date.now() + 30_000,
          nonce: "nonce-one",
          relayId: "relay-one",
          sessionId: "session-one",
          type: "auth.challenge",
        }),
      })
    )

    await Promise.resolve()
    expect(socket?.send).not.toHaveBeenCalled()

    resolveCapability({
      browserOrigin: "https://relay.example.com",
      capability: "eyJjYXBhYmlsaXR5SWQiOiJjYXAtb25lIn0.signature",
      expiresAt: Date.now() + 60_000,
      proxyMode: "none",
      relayId: "relay-one",
    })
    await vi.waitFor(() => expect(socket?.send).toHaveBeenCalledOnce())
    socket?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          instanceId: "instance-one",
          type: "auth.ready",
        }),
      })
    )

    await running

    expect(socket?.send).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(socket?.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "auth",
    })
    expect(JSON.parse(String(socket?.send.mock.calls[1]?.[0]))).toEqual({
      instanceId: "instance-one",
      type: "console.subscribe",
      v: 1,
    })
  })

  it("closes the unauthenticated socket when capability issuance fails", async () => {
    let rejectCapability: (cause: Error) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCapability = reject
      })
    )
    const fetchFallback = vi
      .fn()
      .mockRejectedValue(new Error("Hearth fallback failed"))
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      Effect.result(
        openRelayConsoleStream(
          "relay-one",
          "instance-one",
          "https://relay.example.com"
        ).pipe(Stream.runDrain)
      )
    )

    await vi.waitFor(() => {
      expect(relayCapability.issue).toHaveBeenCalledOnce()
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(FakeWebSocket.instances[0]?.listenerCount).toBe(3)
    })
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          expiresAt: Date.now() + 30_000,
          nonce: "nonce-one",
          relayId: "relay-one",
          sessionId: "session-one",
          type: "auth.challenge",
        }),
      })
    )
    await Promise.resolve()

    rejectCapability(new Error("Console access denied"))
    await running

    const socket = FakeWebSocket.instances[0]
    expect(socket?.send).not.toHaveBeenCalled()
    expect(socket?.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(socket?.listenerCount).toBe(0)
    expect(fetchFallback).toHaveBeenCalledOnce()
    expect(socket?.close.mock.invocationCallOrder[0]).toBeLessThan(
      fetchFallback.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })
})

describe("Relay console socket inbox", () => {
  it("retains a terminal error after queued messages are consumed", async () => {
    const socket = new FakeWebSocket()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createSocketInbox(socket as unknown as WebSocket)

          socket.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "console.line" }),
            })
          )
          const close = new Event("close")
          Object.assign(close, { code: 1006, reason: "Relay disconnected" })
          socket.dispatchEvent(close)

          const message = yield* Queue.take(inbox.messages)
          const terminal = yield* Queue.take(inbox.messages).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => new Error("Expected the inbox to fail"),
            })
          )
          return { message, terminal }
        })
      )
    )

    expect(result.message).toEqual({ type: "console.line" })
    expect(result.terminal).toEqual(new Error("Relay disconnected"))
  })

  it("removes browser listeners when its Effect scope closes", async () => {
    const socket = new FakeWebSocket()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createSocketInbox(socket as unknown as WebSocket)
          expect(socket.listenerCount).toBe(3)
        })
      )
    )

    expect(socket.listenerCount).toBe(0)
  })

  it("keeps the first terminal error when error and close both fire", async () => {
    const socket = new FakeWebSocket()
    const terminal = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createSocketInbox(socket as unknown as WebSocket)
          socket.dispatchEvent(new Event("error"))
          const close = new Event("close")
          Object.assign(close, { code: 1006, reason: "Relay disconnected" })

          expect(() => socket.dispatchEvent(close)).not.toThrow()
          return yield* Queue.take(inbox.messages).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => new Error("Expected the inbox to fail"),
            })
          )
        })
      )
    )

    expect(terminal).toEqual(new Error("Unable to connect to Relay"))
  })

  it("does not recover a cancelled inbox as a typed stream failure", async () => {
    const socket = new FakeWebSocket()
    const fallbackOpened = vi.fn()
    const fiber = Effect.runFork(
      Effect.scoped(
        Stream.unwrap(
          createSocketInbox(socket as unknown as WebSocket).pipe(
            Effect.map(({ messages }) => Stream.fromQueue(messages))
          )
        ).pipe(
          Stream.catch(() => {
            fallbackOpened()
            return Stream.empty
          }),
          Stream.runDrain
        )
      )
    )

    await vi.waitFor(() => expect(socket.listenerCount).toBe(3))
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(fallbackOpened).not.toHaveBeenCalled()
    expect(socket.listenerCount).toBe(0)
  })
})

class FakeWebSocket extends EventTarget {
  static readonly instances: Array<FakeWebSocket> = []

  readonly close = vi.fn()
  listenerCount = 0
  readonly protocol = "kiln-browser-console.v1"
  readonly send = vi.fn()

  constructor() {
    super()
    FakeWebSocket.instances.push(this)
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    this.listenerCount += 1
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    this.listenerCount -= 1
    super.removeEventListener(type, callback, options)
  }
}
