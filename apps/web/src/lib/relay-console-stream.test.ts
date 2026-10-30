import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect, Fiber, Stream } from "effect"

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

import { relayBrowserConsoleProtocol } from "@workspace/contracts"

import { notifyRelayBrowserAuthorizationChanged } from "./relay-browser-credentials"
import {
  openRelayConsoleStream,
  prewarmRelayConsole,
} from "./relay-console-stream"

type ConsoleCapability = {
  browserOrigin: string
  capability: string
  expiresAt: number
  proxyMode: "hearth" | "none"
  relayId: string
}

afterEach(() => {
  // Discards any prewarm a test left, as an authorization change does.
  notifyRelayBrowserAuthorizationChanged()
  relayCapability.issue.mockReset()
  FakeWebSocket.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Relay console connection setup", () => {
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
          { id: "instance-one", kind: "instance" },
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
})

describe("Relay console prewarm", () => {
  const prewarm = {
    browserOrigin: "https://relay.example.com",
    instanceId: "instance-one",
    relayId: "relay-one",
    write: false,
  }
  const openConsole = (write = false) =>
    openRelayConsoleStream(
      "relay-one",
      { id: "instance-one", kind: "instance" },
      "https://relay.example.com",
      null,
      undefined,
      write
    )

  it("discards a prewarm when browser authorization changes", async () => {
    deferredCapability().resolve(consoleCapability())
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)

    prewarmRelayConsole(prewarm)
    const stale = await FakeWebSocket.opened(0)
    dispatchChallenge(stale)
    await subscribed(stale)
    // Such as a sign-out or a permission change while the link was hovered.
    notifyRelayBrowserAuthorizationChanged()
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalled())

    const running = Effect.runPromise(openConsole().pipe(Stream.runHead))
    const next = await FakeWebSocket.opened(1)
    dispatchChallenge(next)
    await finishDirectConnection(next, running)
    expect(next.sent).toEqual([
      expect.objectContaining({ type: "auth" }),
      { instanceId: "instance-one", type: "console.subscribe", v: 1 },
    ])
  })
})

describe("Relay console kept connection", () => {
  const openConsole = (
    browserOrigin: string | null = "https://relay.example.com"
  ) =>
    openRelayConsoleStream(
      "relay-one",
      { id: "instance-one", kind: "instance" },
      browserOrigin
    )

  // Opens a console, has its session sent, and leaves it.
  async function leaveConsole(): Promise<FakeWebSocket> {
    const running = Effect.runFork(openConsole().pipe(Stream.runDrain))
    const socket = await FakeWebSocket.opened(0)
    dispatchChallenge(socket)
    await subscribed(socket)
    socket.receive(reset("first"))
    await flush()
    await Effect.runPromise(Fiber.interrupt(running))
    return socket
  }

  it("brings a console back on the connection it left, with its session afresh", async () => {
    deferredCapability().resolve(consoleCapability())
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal("WebSocket", FakeWebSocket)
    const socket = await leaveConsole()
    // Output keeps coming while nobody reads it.
    socket.receive(line("while away"))

    const events = Effect.runPromise(
      openConsole().pipe(Stream.take(2), Stream.runCollect)
    )
    await socket.sentFrames(3)
    // Sent before the Relay took the new subscription, after a reset that
    // came while nobody read it.
    socket.receive({ instanceId: "instance-one", lifecycle: [], type: "ready" })
    socket.receive(line("in flight"))
    socket.receive(reset("again"))

    expect(await events).toEqual([
      { message: null, transport: "direct", type: "transport" },
      reset("again"),
    ])
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.sent.at(-1)).toEqual({
      instanceId: "instance-one",
      type: "console.subscribe",
      v: 1,
    })
  })
})

function reset(text: string) {
  return {
    instanceId: "instance-one",
    lifecycle: [],
    lines: [line(text).line],
    truncated: false,
    type: "reset",
  }
}

function line(text: string) {
  return {
    line: { id: text, level: "info", text, timestamp: null },
    type: "line",
  }
}

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
  listenerCount = 0
  protocol: string = relayBrowserConsoleProtocol
  readyState = FakeWebSocket.OPEN
  readonly sent: Array<SentFrame> = []
  readonly url: string
  #listening = false
  #sendWaiters = new Set<() => void>()

  constructor(url: string | URL = "wss://relay.example.com/v1/browser") {
    super()
    this.url = String(url)
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
    features: Array<string>
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

/** Lets the stream's fibers and promise callbacks run one event-loop turn. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Answers a socket's auth, then waits for its console subscription. */
async function subscribed(socket: FakeWebSocket): Promise<void> {
  await socket.sentFrames(1)
  socket.receive({ instanceId: "instance-one", type: "auth.ready" })
  await socket.sentFrames(2)
}

async function finishDirectConnection(
  socket: FakeWebSocket,
  running: Promise<unknown>
): Promise<void> {
  await socket.sentFrames(1)
  socket.receive({ instanceId: "instance-one", type: "auth.ready" })
  await running
}
