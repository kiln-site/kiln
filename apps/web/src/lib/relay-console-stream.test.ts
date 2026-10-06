import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect, Fiber, Option, Queue, Stream } from "effect"

const relayCapability = vi.hoisted(() => ({
  issue: vi.fn(),
}))

vi.mock("@/server/relay-capability", () => ({
  issueBrowserCapabilities: (...arguments_: Array<unknown>) =>
    relayCapability
      .issue(...arguments_)
      .then((capability: ConsoleCapability) => ({
        capabilities: [{ ...capability, kind: "console", version: 1 }],
      })),
}))

import { createRelayBrowserSocketInbox } from "./authenticated-relay-socket"
import { openRelayConsoleStream } from "./relay-console-stream"

type ConsoleCapability = {
  browserOrigin: string
  capability: string
  expiresAt: number
  proxyMode: "hearth" | "none"
  relayId: string
}

afterEach(() => {
  relayCapability.issue.mockReset()
  FakeWebSocket.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Relay console connection setup", () => {
  it("reports a failed direct stream before waiting for the fallback", async () => {
    vi.stubGlobal("navigator", { onLine: true })
    const fetchFallback = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetchFallback)
    relayCapability.issue.mockRejectedValue(
      new Error("Capability service unavailable")
    )
    const event = await Effect.runPromise(
      openRelayConsoleStream("relay", "instance", null).pipe(Stream.runHead)
    )
    expect(Option.getOrThrow(event)).toMatchObject({ type: "reconnecting" })
    expect(fetchFallback).not.toHaveBeenCalled()
  })

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
    const capability = deferredCapability()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)

    const running = Effect.runPromise(
      openRelayConsoleStream(
        "relay-one",
        "instance-one",
        "https://relay.example.com"
      ).pipe(Stream.runHead)
    )

    await capability.requested
    const socket = await FakeWebSocket.opened(0)
    dispatchChallenge(socket)

    await flush()
    expect(socket.sent).toEqual([])

    capability.resolve(consoleCapability())
    await finishDirectConnection(socket, running)

    expect(socket.sent).toEqual([
      expect.objectContaining({ type: "auth" }),
      { instanceId: "instance-one", type: "console.subscribe", v: 1 },
    ])
  })

  it("closes the unauthenticated socket without proxying a permission denial", async () => {
    const capability = deferredCapability()
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

    await capability.requested
    const socket = await FakeWebSocket.opened(0)
    dispatchChallenge(socket)
    await flush()

    capability.reject(new Error("Console access denied"))
    await running

    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(socket.listenerCount).toBe(0)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens the direct socket when the speculative attempt fails", async () => {
    const capability = deferredCapability()
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

    await capability.requested
    const firstSocket = await FakeWebSocket.opened(0)
    capability.resolve(consoleCapability())
    dispatchSocketClose(firstSocket, 4401, "Browser authentication timed out")

    const secondSocket = await FakeWebSocket.opened(1)
    expect(firstSocket.listenerCount).toBe(0)
    expect(firstSocket.close).toHaveBeenCalledWith(1000, "Console view closed")

    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(secondSocket.sent.map((frame) => frame.type)).toEqual([
      "auth",
      "console.subscribe",
    ])
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens a speculative socket that closes after receiving its challenge", async () => {
    const capability = deferredCapability()
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

    const firstSocket = await FakeWebSocket.opened(0)
    dispatchChallenge(firstSocket)
    await flush()
    dispatchSocketClose(firstSocket, 1006, "Relay disconnected")
    capability.resolve(consoleCapability())

    const secondSocket = await FakeWebSocket.opened(1)
    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(firstSocket.listenerCount).toBe(0)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens a speculative socket when its challenge expires during capability issuance", async () => {
    let now = 1_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const capability = deferredCapability()
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

    const firstSocket = await FakeWebSocket.opened(0)
    dispatchChallenge(firstSocket, { expiresAt: 2_000 })
    await flush()
    now = 3_000
    capability.resolve(consoleCapability())

    const secondSocket = await FakeWebSocket.opened(1)
    dispatchChallenge(secondSocket, { expiresAt: 4_000 })
    await finishDirectConnection(secondSocket, running)

    expect(firstSocket.listenerCount).toBe(0)
    expect(firstSocket.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("reopens the socket at the capability origin when the cached origin differs", async () => {
    const capability = deferredCapability()
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

    const firstSocket = await FakeWebSocket.opened(0)
    capability.resolve(
      consoleCapability({ browserOrigin: "https://current-relay.example.com" })
    )

    const secondSocket = await FakeWebSocket.opened(1)
    expect(firstSocket.url).toBe("wss://cached-relay.example.com/v1/browser")
    expect(secondSocket.url).toBe("wss://current-relay.example.com/v1/browser")
    expect(firstSocket.listenerCount).toBe(0)

    dispatchChallenge(secondSocket)
    await finishDirectConnection(secondSocket, running)

    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it("closes the speculative socket before using the Hearth proxy", async () => {
    const capability = deferredCapability()
    let socketStateAtFallback: number | undefined
    const fetchFallback = vi.fn(() => {
      socketStateAtFallback = FakeWebSocket.instances[0]?.readyState
      return Promise.reject(new Error("Hearth fallback failed"))
    })
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

    const socket = await FakeWebSocket.opened(0)
    capability.resolve(consoleCapability({ proxyMode: "hearth" }))
    await running

    expect(socket.sent).toEqual([])
    expect(socket.listenerCount).toBe(0)
    expect(socket.close).toHaveBeenCalledWith(1000, "Console view closed")
    expect(socketStateAtFallback).toBe(FakeWebSocket.CLOSED)
  })

  it("keeps the serial connection path when no cached origin is available", async () => {
    const capability = deferredCapability()
    const fetchFallback = vi.fn()
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    vi.stubGlobal("fetch", fetchFallback)

    const running = Effect.runPromise(
      openRelayConsoleStream("relay-one", "instance-one", null).pipe(
        Stream.runHead
      )
    )

    await capability.requested
    expect(FakeWebSocket.instances).toHaveLength(0)
    capability.resolve(consoleCapability())

    const socket = await FakeWebSocket.opened(0)
    expect(socket.url).toBe("wss://relay.example.com/v1/browser")
    dispatchChallenge(socket)
    await finishDirectConnection(socket, running)

    expect(fetchFallback).not.toHaveBeenCalled()
  })
})

describe("Relay console socket inbox", () => {
  it("routes operation replies outside the bounded console queue", async () => {
    const socket = new FakeWebSocket()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createConsoleInbox(socket)
          const request = inbox.request(
            socket as unknown as WebSocket,
            "instance-one",
            "console.complete",
            { cursor: 0, input: "" }
          )
          socket.receive({
            payload: { suggestions: [] },
            requestId: socket.sent[0]?.requestId,
            type: "operation.result",
          })
          socket.receive({ type: "console.line" })
          const payload = yield* Effect.promise(() => request)
          return { next: yield* inbox.take, payload }
        })
      )
    )

    expect(result).toEqual({
      next: { type: "console.line" },
      payload: { suggestions: [] },
    })
  })

  it("retains a terminal error after queued messages are consumed", async () => {
    const socket = new FakeWebSocket()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* createConsoleInbox(socket)

          socket.receive({ type: "console.line" })
          dispatchSocketClose(socket, 1006, "Relay disconnected")

          const message = yield* inbox.take
          const terminal = yield* inbox.take.pipe(
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
          yield* createConsoleInbox(socket)
          expect(socket.listenerCount).toBeGreaterThan(0)
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
          const inbox = yield* createConsoleInbox(socket)
          socket.dispatchEvent(new Event("error"))

          expect(() =>
            dispatchSocketClose(socket, 1006, "Relay disconnected")
          ).not.toThrow()
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
          createConsoleInbox(socket).pipe(
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

    await socket.listening
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(fallbackOpened).not.toHaveBeenCalled()
    expect(socket.listenerCount).toBe(0)
  })
})

type SentFrame = Record<string, unknown>

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3
  static readonly instances: Array<FakeWebSocket> = []
  static readonly OPEN = 1
  static readonly #waiters = new Set<() => void>()

  /** Resolves once the `index`th socket is listening for Relay frames. */
  static opened(index: number): Promise<FakeWebSocket> {
    return new Promise((resolve) => {
      const check = () => {
        const socket = FakeWebSocket.instances[index]
        if (!socket || !socket.#listening) return
        FakeWebSocket.#waiters.delete(check)
        resolve(socket)
      }
      FakeWebSocket.#waiters.add(check)
      check()
    })
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0
    FakeWebSocket.#waiters.clear()
  }

  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
  })
  readonly listening: Promise<void>
  listenerCount = 0
  readonly protocol = "kiln-browser-console.v1"
  readyState = FakeWebSocket.OPEN
  readonly sent: Array<SentFrame> = []
  readonly url: string
  #listening = false
  #markListening: () => void = () => undefined
  #sendWaiters = new Set<() => void>()

  constructor(url: string | URL = "wss://relay.example.com/v1/browser") {
    super()
    this.url = String(url)
    this.listening = new Promise((resolve) => {
      this.#markListening = resolve
    })
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame)
    for (const waiter of this.#sendWaiters) waiter()
  }

  /** Resolves once the browser has sent `count` frames to the Relay. */
  sentFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length < count) return
        this.#sendWaiters.delete(check)
        resolve()
      }
      this.#sendWaiters.add(check)
      check()
    })
  }

  receive(frame: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) })
    )
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
    if (type !== "message" || this.#listening) return
    this.#listening = true
    this.#markListening()
    for (const waiter of FakeWebSocket.#waiters) waiter()
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

function createConsoleInbox(socket: FakeWebSocket) {
  return createRelayBrowserSocketInbox(
    socket as unknown as WebSocket,
    "console"
  )
}

function deferredCapability(): {
  reject: (cause: Error) => void
  requested: Promise<void>
  resolve: (capability: ConsoleCapability) => void
} {
  let markRequested: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  const deferred = {
    reject: (_cause: Error) => undefined as void,
    requested,
    resolve: (_capability: ConsoleCapability) => undefined as void,
  }
  const issued = new Promise<ConsoleCapability>((resolve, reject) => {
    deferred.resolve = resolve
    deferred.reject = reject
  })
  relayCapability.issue.mockImplementation(() => {
    markRequested()
    return issued
  })
  return deferred
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
  socket: FakeWebSocket,
  overrides: Partial<{
    expiresAt: number
    nonce: string
    relayId: string
    sessionId: string
  }> = {}
): void {
  socket.receive({
    expiresAt: Date.now() + 30_000,
    nonce: "nonce-one",
    relayId: "relay-one",
    sessionId: "session-one",
    type: "auth.challenge",
    ...overrides,
  })
}

function dispatchSocketClose(
  socket: FakeWebSocket,
  code: number,
  reason: string
): void {
  const close = new Event("close")
  Object.assign(close, { code, reason })
  socket.dispatchEvent(close)
}

/** Lets the stream's fibers and promise callbacks run one event-loop turn. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function finishDirectConnection(
  socket: FakeWebSocket,
  running: Promise<unknown>
): Promise<void> {
  await socket.sentFrames(1)
  socket.receive({ instanceId: "instance-one", type: "auth.ready" })
  await running
}
