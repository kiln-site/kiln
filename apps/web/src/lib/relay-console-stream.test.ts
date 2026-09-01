import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect, Fiber, Option, Queue, Stream } from "effect"

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

type ConsoleCapability = {
  browserOrigin: string
  capability: string
  expiresAt: number
  proxyMode: "hearth" | "none"
  relayId: string
}

afterEach(() => {
  relayCapability.issue.mockReset()
  FakeWebSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Relay console connection setup", () => {
  it("opens Hearth immediately when synchronized routing selects it", async () => {
    const fetchStream = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchStream)

    const event = await Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://relay.example.com",
        "hearth"
      ).pipe(Stream.runHead)
    )

    expect(Option.getOrThrow(event)).toEqual({
      message: null,
      transport: "hearth",
      type: "transport",
    })
    expect(fetchStream).toHaveBeenCalledWith(
      "/api/console/instance-one?relayId=relay-one",
      expect.objectContaining({ cache: "no-store" })
    )
    expect(relayCapability.issue).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

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

  it("reopens the direct socket when the speculative attempt fails", async () => {
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

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
    resolveCapability(consoleCapability())
    dispatchSocketClose(
      FakeWebSocket.instances[0],
      4401,
      "Browser authentication timed out"
    )

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const firstSocket = FakeWebSocket.instances[0]
    const secondSocket = FakeWebSocket.instances[1]
    expect(firstSocket?.listenerCount).toBe(0)
    expect(firstSocket?.close).toHaveBeenCalledWith(1000, "Console view closed")

    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(secondSocket?.send).toHaveBeenCalledTimes(2)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens a speculative socket that closes after receiving its challenge", async () => {
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://relay.example.com"
      ).pipe(Stream.runHead)
    )

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const firstSocket = FakeWebSocket.instances[0]
    dispatchChallenge(firstSocket)
    await Promise.resolve()
    dispatchSocketClose(firstSocket, 1006, "Relay disconnected")
    resolveCapability(consoleCapability())

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const secondSocket = FakeWebSocket.instances[1]
    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(firstSocket?.listenerCount).toBe(0)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens a speculative socket when its challenge expires during capability issuance", async () => {
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://relay.example.com"
      ).pipe(Stream.runHead)
    )

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const firstSocket = FakeWebSocket.instances[0]
    dispatchChallenge(firstSocket, { expiresAt: 2_000 })
    await Promise.resolve()
    now = 3_000
    resolveCapability(consoleCapability())

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const secondSocket = FakeWebSocket.instances[1]
    dispatchChallenge(secondSocket, { expiresAt: 4_000 })
    await finishDirectConnection(secondSocket, running)

    expect(firstSocket?.listenerCount).toBe(0)
    expect(firstSocket?.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens the socket at the capability origin when the cached origin differs", async () => {
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://cached-relay.example.com"
      ).pipe(Stream.runHead)
    )

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    resolveCapability(
      consoleCapability({ browserOrigin: "https://current-relay.example.com" })
    )

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const firstSocket = FakeWebSocket.instances[0]
    const secondSocket = FakeWebSocket.instances[1]
    expect(firstSocket?.url).toBe("wss://cached-relay.example.com/v1/browser")
    expect(secondSocket?.url).toBe("wss://current-relay.example.com/v1/browser")
    expect(firstSocket?.listenerCount).toBe(0)

    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("closes the speculative socket before using the Hearth proxy", async () => {
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
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

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    resolveCapability(consoleCapability({ proxyMode: "hearth" }))
    await running

    const socket = FakeWebSocket.instances[0]
    expect(socket?.send).not.toHaveBeenCalled()
    expect(socket?.listenerCount).toBe(0)
    expect(socket?.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(fetchFallback).toHaveBeenCalledOnce()
    expect(socket?.close.mock.invocationCallOrder[0]).toBeLessThan(
      fetchFallback.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it("keeps the serial connection path when no cached origin is available", async () => {
    let resolveCapability: (value: ConsoleCapability) => void = () => undefined
    relayCapability.issue.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve
      })
    )
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      openRelayConsoleStream("relay-one", "instance-one", null).pipe(
        Stream.runHead
      )
    )

    await vi.waitFor(() => expect(relayCapability.issue).toHaveBeenCalledOnce())
    expect(FakeWebSocket.instances).toHaveLength(0)
    resolveCapability(consoleCapability())

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]
    expect(socket?.url).toBe("wss://relay.example.com/v1/browser")
    dispatchChallenge(socket)
    await finishDirectConnection(socket, running)

    expect(fetchFallback).not.toHaveBeenCalled()
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
  static readonly CLOSED = 3
  static readonly instances: Array<FakeWebSocket> = []
  static readonly OPEN = 1

  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })
  listenerCount = 0
  readonly protocol = "kiln-browser-console.v1"
  readyState = FakeWebSocket.OPEN
  readonly send = vi.fn()
  readonly url: string

  constructor(url: string | URL = "wss://relay.example.com/v1/browser") {
    super()
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  override dispatchEvent(event: Event): boolean {
    if (event.type === "close") this.readyState = FakeWebSocket.CLOSED
    return super.dispatchEvent(event)
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

function consoleCapability(
  overrides: Partial<ConsoleCapability> = {}
): ConsoleCapability {
  return {
    browserOrigin: "https://relay.example.com",
    capability: "eyJjYXBhYmlsaXR5SWQiOiJjYXAtb25lIn0.signature",
    expiresAt: Date.now() + 60_000,
    proxyMode: "none",
    relayId: "relay-one",
    ...overrides,
  }
}

function dispatchChallenge(
  socket: FakeWebSocket | undefined,
  overrides: Partial<{
    expiresAt: number
    nonce: string
    relayId: string
    sessionId: string
  }> = {}
): void {
  socket?.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        expiresAt: Date.now() + 30_000,
        nonce: "nonce-one",
        relayId: "relay-one",
        sessionId: "session-one",
        type: "auth.challenge",
        ...overrides,
      }),
    })
  )
}

function dispatchSocketClose(
  socket: FakeWebSocket | undefined,
  code: number,
  reason: string
): void {
  const close = new Event("close")
  Object.assign(close, { code, reason })
  socket?.dispatchEvent(close)
}

async function finishDirectConnection(
  socket: FakeWebSocket | undefined,
  running: Promise<unknown>
): Promise<void> {
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
}
