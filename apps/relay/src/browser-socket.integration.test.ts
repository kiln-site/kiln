import { createHash, generateKeyPairSync, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import type { Server } from "node:http"
import type { Duplex } from "node:stream"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { WebSocket } from "ws"

import {
  relayBrowserConsoleProtocol,
  relayBrowserProofTranscript,
  type RelayBrowserCapabilityV2,
  type RelayConsoleLine,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import { attachBrowserSocket } from "./browser-socket.js"
import type { BrowserSocketServer } from "./browser-socket.js"
import { consoleSources } from "./console-sources.js"
import { sendRawRequest } from "./test/raw-http.js"
import type { RelayStateStore } from "./effect/state.js"
import type { RelayIdentity } from "./effect/identity.js"
import type { DockerConsoleSession, DockerDriver } from "./docker.js"
import type { FilesystemDriver } from "./files.js"
import type { RelaySnapshotSample } from "./snapshot-hub.js"

const origin = "https://hearth.test"
const relayId = "relay-test-fingerprint"
// A server and a database can share an ID; their consoles stay apart.
const sharedId = "resource-test"
const openResources: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(openResources.splice(0).map((close) => close()))
})

describe("relay browser socket integration", () => {
  it("ignores upgrade targets that URL parsing rejects instead of crashing", async () => {
    const relay = await startRelay()
    const upgraded = once(relay.server, "upgrade")

    const malformed = sendRawRequest(relay.port, "//%", { upgrade: true })
    // Listeners run in registration order; the browser socket's has returned.
    const [, upgradedSocket] = (await upgraded) as [unknown, Duplex]
    // Production answers these with 400 from index.ts; this harness has no
    // such listener, so release the parked socket.
    upgradedSocket.destroy()
    malformed.destroy()
    const messages = messageCollector(relay.connect(origin))
    expect(await messages.next("auth.challenge")).toBeDefined()
  })

  it("authenticates, renews with nonce rotation, and closes on a revision floor", async () => {
    const relay = await startRelay()
    const socket = relay.connect(origin)
    const messages = messageCollector(socket)

    const challenge = await messages.next("auth.challenge")
    const firstCapability = capability({
      capabilityId: "capability-1",
      keyThumbprint: relay.browser.keyThumbprint,
      revision: 1,
    })
    socket.send(
      JSON.stringify({
        capability: encodeCapability(firstCapability, relay.issuerPrivateKey),
        publicKeyJwk: relay.browser.jwk,
        signature: browserProof(
          relay.browser.privateKey,
          challenge,
          firstCapability.capabilityId
        ),
        type: "auth",
        v: 1,
      })
    )
    const ready = await messages.next("auth.ready")
    expect(ready.instanceId).toBe("instance-test")
    expect(typeof ready.renewalNonce).toBe("string")

    const renewedCapability = capability({
      capabilityId: "capability-2",
      keyThumbprint: relay.browser.keyThumbprint,
      revision: 1,
    })
    socket.send(
      JSON.stringify({
        capability: encodeCapability(renewedCapability, relay.issuerPrivateKey),
        signature: browserProof(
          relay.browser.privateKey,
          {
            expiresAt: ready.renewalNonceExpiresAt,
            nonce: ready.renewalNonce,
            relayId,
            sessionId: ready.sessionId,
          },
          renewedCapability.capabilityId
        ),
        type: "auth.renew",
        v: 1,
      })
    )
    const renewed = await messages.next("auth.renewed")
    expect(renewed.renewalNonce).not.toBe(ready.renewalNonce)
    expect(renewed.expiresAt).toBe(renewedCapability.expiresAt)

    relay.setAuthority({ issuerGeneration: 1, minimumRevision: 2 })
    const closed = messages.closed()
    relay.browserServer.reviseAuthorization(
      relay.clientId,
      [
        {
          minimumRevision: 2,
          scope: { instanceId: "instance-test", kind: "instance" },
          subject: "user-test",
        },
      ],
      1
    )
    await expect(closed).resolves.toEqual({
      code: 4403,
      reason: "Browser authorization changed",
    })
  })

  it("rejects a capability that the paired Hearth did not sign", async () => {
    const relay = await startRelay()
    const forger = generateKeyPairSync("ed25519")
    const result = await attemptAuthentication(relay, {
      issuerPrivateKey: forger.privateKey,
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("rejects a proof that the capability's browser key did not sign", async () => {
    const relay = await startRelay()
    const otherBrowser = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const result = await attemptAuthentication(relay, {
      proofPrivateKey: otherBrowser.privateKey,
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("takes a console subscription sent right behind the auth", async () => {
    const relay = await startRelay()
    const socket = relay.connect(origin)
    const messages = messageCollector(socket)
    const challenge = await messages.next("auth.challenge")
    expect(challenge.features).toContain("early-messages")

    sendAuth(socket, relay, challenge, databaseCapability)
    // Without waiting for `auth.ready`.
    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )

    await messages.next("auth.ready")
    const reset = await messages.next("reset")
    expect(reset.instanceId).toBe(sharedId)
    expect(lineTexts(reset)).toEqual([`container container-${sharedId} output`])
  })

  // A browser's trace context is only telemetry; none can stop its console.
  it.each([
    ["a trace context", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"],
    ["a malformed trace context", "00-not-a-trace-01"],
    ["an oversized trace context", `00-${"a".repeat(4_096)}`],
    ["a trace context that is not text", { traceId: 1 }],
  ])("serves a console whose browser sends %s", async (_, traceparent) => {
    const relay = await startRelay()
    const socket = relay.connect(origin)
    const messages = messageCollector(socket)
    const challenge = await messages.next("auth.challenge")

    sendAuth(socket, relay, challenge, databaseCapability, {}, { traceparent })
    await messages.next("auth.ready")
    socket.send(
      JSON.stringify({
        instanceId: sharedId,
        traceparent,
        type: "console.subscribe",
        v: 1,
      })
    )

    const reset = await messages.next("reset")
    expect(lineTexts(reset)).toEqual([`container container-${sharedId} output`])
  })

  it("drops what follows an auth the Relay rejects", async () => {
    const relay = await startRelay()
    const socket = relay.connect(origin)
    const messages = messageCollector(socket)
    const received: Array<string> = []
    socket.on("message", (data) => {
      received.push(
        String((JSON.parse(data.toString()) as { type: unknown }).type)
      )
    })
    const challenge = await messages.next("auth.challenge")
    const closed = messages.closed()

    sendAuth(socket, relay, challenge, databaseCapability, {
      issuerPrivateKey: generateKeyPairSync("ed25519").privateKey,
    })
    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )

    await expect(closed).resolves.toMatchObject({ code: 4401 })
    expect(received).not.toContain("reset")
    expect(received).not.toContain("auth.ready")
  })

  it("streams a database's console to a capability for that database", async () => {
    const relay = await startRelay()
    const { messages, socket } = await authenticate(relay, databaseCapability)

    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )

    const reset = await messages.next("reset")
    expect(reset.instanceId).toBe(sharedId)
    expect(lineTexts(reset)).toEqual([`container container-${sharedId} output`])
  })

  it("keeps a server's console from a capability for a database", async () => {
    const relay = await startRelay()
    const { messages, socket } = await authenticate(relay, databaseCapability)
    const closed = messages.closed()

    socket.send(
      JSON.stringify({
        command: "stop",
        instanceId: sharedId,
        requestId: "request-1",
        type: "console.write",
        v: 1,
      })
    )

    await expect(closed).resolves.toMatchObject({ code: 4403 })
  })

  it("refuses a database capability carrying a server's console actions", async () => {
    const relay = await startRelay()
    const result = await attemptAuthentication(relay, {
      capability: {
        ...databaseCapability,
        actions: ["instance.console.read"],
      },
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("refuses database consoles to a Hearth the Relay doesn't let read them", async () => {
    const relay = await startRelay({ actions: ["instance.console.read"] })
    const result = await attemptAuthentication(relay, {
      capability: databaseCapability,
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("lets a fully trusted Hearth paired before database consoles read them", async () => {
    const relay = await startRelay({
      actions: ["instance.console.read"],
      role: "full_access",
    })
    const { messages, socket } = await authenticate(relay, databaseCapability)

    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )

    await expect(messages.next("reset")).resolves.toMatchObject({
      instanceId: sharedId,
    })
  })

  it("streams the Relay's own container to a capability for its logs", async () => {
    const relay = await startRelay({ actions: ["relay.logs.read"] })
    const { messages, socket } = await authenticate(relay, relayLogsCapability)

    socket.send(
      JSON.stringify({ instanceId: relayId, type: "console.subscribe", v: 1 })
    )

    const reset = await messages.next("reset")
    expect(lineTexts(reset)).toEqual(["container relay-container output"])
  })

  it("refuses Relay logs to a Hearth the Relay doesn't let read them", async () => {
    const relay = await startRelay()
    const result = await attemptAuthentication(relay, {
      capability: relayLogsCapability,
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("refuses a Relay logs capability carrying a server's console actions", async () => {
    const relay = await startRelay({
      actions: ["relay.logs.read", "instance.console.write"],
    })
    const result = await attemptAuthentication(relay, {
      capability: {
        ...relayLogsCapability,
        actions: ["relay.logs.read", "instance.console.write"],
      },
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("closes a database console when the person's access on the Relay changes", async () => {
    const relay = await startRelay()
    const { messages, socket } = await authenticate(relay, databaseCapability)
    const closed = messages.closed()

    // A server sharing the database's ID changing access leaves it open: the
    // console still streams after.
    relay.browserServer.reviseAuthorization(
      relay.clientId,
      [
        {
          minimumRevision: 2,
          scope: { instanceId: sharedId, kind: "instance" },
          subject: "user-test",
        },
      ],
      1
    )
    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )
    await messages.next("reset")

    relay.browserServer.reviseAuthorization(
      relay.clientId,
      [
        {
          minimumRevision: 2,
          scope: { kind: "subject_relay" },
          subject: "user-test",
        },
      ],
      1
    )

    await expect(closed).resolves.toEqual({
      code: 4403,
      reason: "Browser authorization changed",
    })
  })

  it("delivers a history larger than the socket's outbox", async () => {
    const relay = await startRelay()
    const { messages, socket } = await authenticate(relay, {
      instanceId: largeHistoryId,
    })
    let closedEarly = false
    socket.once("close", () => {
      closedEarly = true
    })

    socket.send(
      JSON.stringify({
        instanceId: largeHistoryId,
        type: "console.subscribe",
        v: 1,
      })
    )
    let received = lineTexts(await messages.next("reset")).length
    while (received < largeHistoryLines) {
      received += lineTexts(await messages.next("history")).length
    }

    expect(received).toBe(largeHistoryLines)
    expect(closedEarly).toBe(false)
  })

  it("gives every browser joining a busy console its whole log", async () => {
    const live = new LiveConsole("busy-console")
    live.start("2026-01-01T00:00:00.000Z", 5_000, 1_000)
    const relay = await startRelay({}, [live])
    // The first browser opens the console, which then reads all of its
    // history.
    const first = await openConsole(relay, live)
    const history = live.lines.map((line) => line.id)
    await first.until(() => first.showing(history))

    // Others join while it keeps writing, and are slow to read what they're
    // sent.
    const joined: Array<Awaited<ReturnType<typeof openConsole>>> = []
    for (let index = 0; index < 4; index += 1) {
      const view = await openConsole(relay, live)
      view.socket.pause()
      joined.push(view)
      live.write(30)
    }
    for (const view of joined) view.socket.resume()
    live.write(30)
    const all = live.lines.map((line) => line.id)
    // The console keeps its newest 5,000 lines.
    const kept = all.slice(-5_000)

    for (const view of [first, ...joined]) {
      await view.until(() => view.showing(kept))
      const shown = view.lineIds()
      // Older lines may come along, but none are missing or out of order.
      expect(shown).toEqual(all.slice(all.indexOf(shown[0]!)))
    }
  })

  it("stops sending a run's history once the server restarts", async () => {
    const live = new LiveConsole("restarting-console")
    // History far larger than what the socket buffers.
    live.start("2026-01-01T00:00:00.000Z", 1_000, 10_000)
    const relay = await startRelay({}, [live])
    const first = await openConsole(relay, live)
    await first.until(() => first.showing(live.lines.map((line) => line.id)))
    // A browser joins and is slow to read its history.
    const slow = await openConsole(relay, live)
    slow.socket.pause()

    live.start("2026-01-01T01:00:00.000Z", 300, 10_000)
    relay.reportRuns()
    slow.socket.resume()
    const restarted = live.lines.map((line) => line.id)
    await slow.until(() => slow.showing(restarted))

    expect(slow.lineIds()).toEqual(restarted)
    const reset = slow.runs.findIndex((run) => run.startedAt === live.startedAt)
    expect(reset).toBeGreaterThan(0)
    expect(
      slow.runs.slice(reset).filter((run) => run.startedAt !== live.startedAt)
    ).toEqual([])
  })

  it("sends a slow browser the whole of a run that starts while it reads the last", async () => {
    const live = new LiveConsole("short-restart-console")
    live.start("2026-01-01T00:00:00.000Z", 1_000, 10_000)
    const relay = await startRelay({}, [live])
    const first = await openConsole(relay, live)
    await first.until(() => first.showing(live.lines.map((line) => line.id)))
    // A browser joins and is slow to read its history.
    const slow = await openConsole(relay, live)
    slow.socket.pause()

    // The new run's newest lines all fit in its reset; the rest are read
    // after, while the slow browser still hasn't caught up.
    live.start("2026-01-01T01:00:00.000Z", 1_000, 40)
    relay.reportRuns()
    const restarted = live.lines.map((line) => line.id)
    await first.until(() => first.showing(restarted))
    slow.socket.resume()
    const written = live.write(1).map((line) => line.id)
    await slow.until(() => slow.showing(written))

    await slow.until(() => slow.showing(restarted))
    expect(slow.lineIds()).toEqual([...restarted, ...written])
  })

  it("rejects a socket from an origin the capability was not issued to", async () => {
    const relay = await startRelay()
    const result = await attemptAuthentication(relay, {
      socketOrigin: "https://attacker.test",
    })

    expect(result.ready).toBe(false)
    expect(result.closed.code).toBe(4401)
  })

  it("cuts off a file request whose authentication never completes", async () => {
    const relay = await startRelay()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const request = httpRequest({
      headers: {
        "Content-Length": "1024",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
      },
      host: "127.0.0.1",
      method: "POST",
      path: "/v1/browser/files/instance-test",
      port: relay.port,
    })
    const outcome = new Promise<Error | number>((resolve) => {
      request.once("error", resolve)
      request.once("response", (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
    })
    request.flushHeaders()
    await relay.nextFileRequest()

    await vi.runOnlyPendingTimersAsync()

    await expect(outcome).resolves.toMatchObject({ code: "ECONNRESET" })
  })
})

interface TestRelay {
  readonly browser: {
    readonly jwk: { crv: "P-256"; kty: "EC"; x: string; y: string }
    readonly keyThumbprint: string
    readonly privateKey: KeyObject
  }
  readonly browserServer: BrowserSocketServer
  readonly clientId: string
  readonly connect: (socketOrigin: string) => WebSocket
  readonly issuerPrivateKey: KeyObject
  readonly nextFileRequest: () => Promise<void>
  readonly reportRuns: () => void
  readonly port: number
  readonly server: Server
  readonly setAuthority: (authority: {
    issuerGeneration: number
    minimumRevision: number
  }) => void
}

// This server's history is several times the test outbox (2 MiB).
const largeHistoryId = "large-history"
const largeHistoryLines = 1_000

// A server console the test writes to, and restarts, as a running server
// would.
class LiveConsole {
  readonly id: string
  lines: Array<RelayConsoleLine> = []
  startedAt = ""
  #written = 0
  readonly #wakers = new Set<() => void>()

  constructor(id: string) {
    this.id = id
  }

  // Starts a new run whose history is `count` lines of `width` characters.
  start(startedAt: string, count: number, width: number): void {
    this.startedAt = startedAt
    this.lines = []
    this.write(count, width)
  }

  write(count: number, width = 40): Array<RelayConsoleLine> {
    const written = Array.from({ length: count }, () => {
      const index = this.#written++
      return {
        id: `line-${index}`,
        level: "info" as const,
        text: `${index} ${"x".repeat(width)}`,
        timestamp: new Date(Date.parse(this.startedAt) + index).toISOString(),
      }
    })
    this.lines.push(...written)
    for (const wake of this.#wakers) wake()
    return written
  }

  session(): DockerConsoleSession {
    const lines = this.lines
    const startedAt = this.startedAt
    return {
      history: (limit = 2_000) =>
        Promise.resolve({
          instanceId: this.id,
          lifecycle: [{ state: "started", time: startedAt }],
          lines: lines.slice(-limit),
          truncated: lines.length > limit,
        }),
      stream: (signal) => this.#follow(lines, signal),
    }
  }

  // Like Docker following a log: the newest lines, then what follows, until
  // the run ends.
  async *#follow(
    lines: Array<RelayConsoleLine>,
    signal: AbortSignal
  ): AsyncIterable<RelayConsoleLine> {
    let next = Math.max(0, lines.length - 200)
    while (!signal.aborted && this.lines === lines) {
      while (next < lines.length) yield lines[next++]!
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#wakers.delete(wake)
          signal.removeEventListener("abort", wake)
          resolve()
        }
        this.#wakers.add(wake)
        signal.addEventListener("abort", wake, { once: true })
      })
    }
  }
}

// The Relay's consoles: each server and database container writes one line,
// besides the server with a large history.
function consoleSession(
  resourceId: string,
  text: string
): DockerConsoleSession {
  const startedAt = "2026-01-01T00:00:00.000Z"
  const lines =
    resourceId === largeHistoryId
      ? Array.from({ length: largeHistoryLines }, (_, index) => ({
          id: `line-${index}`,
          level: "info" as const,
          text: `${index} ${"x".repeat(10_000)}`,
          timestamp: new Date(Date.parse(startedAt) + index).toISOString(),
        }))
      : [{ id: "line-1", level: "info" as const, text, timestamp: startedAt }]
  return {
    history: (limit = 2_000) =>
      Promise.resolve({
        instanceId: resourceId,
        lifecycle: [{ state: "started", time: startedAt }],
        lines: lines.slice(-limit),
        truncated: lines.length > limit,
      }),
    // Nothing more is written until the follower stops.
    stream: (signal) => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<RelayConsoleLine>>((resolve) =>
            signal.addEventListener(
              "abort",
              () => resolve({ done: true, value: undefined }),
              { once: true }
            )
          ),
      }),
    }),
  }
}

async function startRelay(
  clientGrant: {
    actions?: Array<string>
    role?: "custom" | "full_access"
  } = {},
  liveConsoles: ReadonlyArray<LiveConsole> = []
): Promise<TestRelay> {
  const snapshotListeners = new Set<(sample: RelaySnapshotSample) => void>()
  const issuerKeys = generateKeyPairSync("ed25519")
  const browserKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const publicKeyJwk = browserKeys.publicKey.export({ format: "jwk" })
  if (
    publicKeyJwk.kty !== "EC" ||
    publicKeyJwk.crv !== "P-256" ||
    !publicKeyJwk.x ||
    !publicKeyJwk.y
  ) {
    throw new Error("Expected a P-256 browser key")
  }
  const browserJwk = {
    crv: "P-256" as const,
    kty: "EC" as const,
    x: publicKeyJwk.x,
    y: publicKeyJwk.y,
  }
  const keyThumbprint = createHash("sha256")
    .update(JSON.stringify(browserJwk))
    .digest("base64url")
  let currentAuthority = { issuerGeneration: 1, minimumRevision: 0 }
  const client = {
    actions: clientGrant.actions ?? [
      "instance.console.read",
      "database.logs.read",
    ],
    createdAt: Date.now(),
    id: "hearth-test",
    invitationId: "invitation-test",
    lastAddress: null,
    lastSeenAt: null,
    name: "Hearth Test",
    origins: [origin],
    publicKey: issuerKeys.publicKey
      .export({
        format: "pem",
        type: "spki",
      })
      .toString(),
    role: clientGrant.role ?? ("custom" as const),
    sourceCidrs: [],
  }
  const state = {
    browserAuthority: () => Effect.succeed(currentAuthority),
    findClientById: (id: string) =>
      Effect.succeed(id === client.id ? client : null),
    listClients: () => Effect.succeed([client]),
  } as unknown as RelayStateStore["Service"]
  const fileRequests: Array<() => void> = []
  let browserServer: BrowserSocketServer | null = null
  const server = createServer((request, response) => {
    const handled = browserServer?.handleRequest(request, response)
    fileRequests.shift()?.()
    void handled?.then((matched) => {
      if (!matched) response.writeHead(404).end()
    })
  })
  browserServer = attachBrowserSocket({
    config: {
      browserLimits: {
        fileReplayEntries: 100,
        outboxBytes: 2 * 1024 * 1024,
        outboxMessages: 256,
        pendingFileAuthentications: 16,
        pendingHandshakes: 16,
        pendingHandshakesPerIp: 16,
        sessions: 16,
        sessionsPerInstance: 16,
        sessionsPerUser: 16,
        sessionsPerUserInstance: 16,
        sublimitsEnforced: true,
      },
      proxyMode: "none",
    },
    consoleSources: consoleSources(
      {
        consoleSession: (id) =>
          Promise.resolve(
            liveConsoles.find((live) => live.id === id)?.session() ??
              consoleSession(id, `server ${id} output`)
          ),
        containerConsoleSession: (id, containerId) =>
          Promise.resolve(
            consoleSession(id, `container ${containerId} output`)
          ),
      },
      {
        target: (id) =>
          Promise.resolve({
            containerId: `container-${id}`,
          } as RelayManagedDatabase),
      },
      {
        consoleSession: (id) =>
          Promise.resolve(consoleSession(id, `app ${id} output`)),
      },
      () => ({ containerId: "relay-container", id: relayId })
    ),
    docker: {} as DockerDriver,
    filesystem: {} as FilesystemDriver,
    identity: { fingerprint: relayId } as RelayIdentity,
    runEffect: (effect) => Effect.runPromise(effect),
    server,
    state,
    subscribeSnapshots: (listener) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
  })
  const attached = browserServer
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  openResources.push(async () => {
    server.closeAllConnections()
    await attached.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected an IP server address")
  }
  return {
    browser: {
      jwk: browserJwk,
      keyThumbprint,
      privateKey: browserKeys.privateKey,
    },
    browserServer: attached,
    clientId: client.id,
    connect: (socketOrigin) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/v1/browser`,
        relayBrowserConsoleProtocol,
        { origin: socketOrigin }
      )
      openResources.push(async () => {
        if (socket.readyState === WebSocket.OPEN) socket.terminate()
      })
      return socket
    },
    issuerPrivateKey: issuerKeys.privateKey,
    // Reports each live console's current run, as the Relay's snapshots do.
    reportRuns: () => {
      const sample = {
        sequence: 1,
        snapshot: {
          instances: liveConsoles.map((live) => ({
            id: live.id,
            lifecycle: [{ state: "started", time: live.startedAt }],
          })),
        },
      } as unknown as RelaySnapshotSample
      for (const listener of snapshotListeners) listener(sample)
    },
    nextFileRequest: () =>
      new Promise<void>((resolve) => {
        fileRequests.push(resolve)
      }),
    port: address.port,
    server,
    setAuthority: (authority) => {
      currentAuthority = authority
    },
  }
}

// Authenticates a socket with a capability built from `overrides`.
async function authenticate(
  relay: TestRelay,
  overrides: Partial<RelayBrowserCapabilityV2>
) {
  const socket = relay.connect(origin)
  const messages = messageCollector(socket)
  const challenge = await messages.next("auth.challenge")
  const authCapability = {
    ...capability({
      capabilityId: "capability-1",
      keyThumbprint: relay.browser.keyThumbprint,
      revision: 1,
    }),
    ...overrides,
  }
  socket.send(
    JSON.stringify({
      capability: encodeCapability(authCapability, relay.issuerPrivateKey),
      publicKeyJwk: relay.browser.jwk,
      signature: browserProof(
        relay.browser.privateKey,
        challenge,
        authCapability.capabilityId
      ),
      type: "auth",
      v: 1,
    })
  )
  await messages.next("auth.ready")
  return { messages, socket }
}

// Sends a browser's auth for `overrides`, as `authenticate` does, without
// waiting for the Relay's answer.
function sendAuth(
  socket: WebSocket,
  relay: TestRelay,
  challenge: Record<string, unknown>,
  overrides: Partial<RelayBrowserCapabilityV2>,
  keys: { issuerPrivateKey?: KeyObject } = {},
  // Further fields of the auth message, such as a trace context.
  extra: Record<string, unknown> = {}
): void {
  const authCapability = {
    ...capability({
      capabilityId: "capability-1",
      keyThumbprint: relay.browser.keyThumbprint,
      revision: 1,
    }),
    ...overrides,
  }
  socket.send(
    JSON.stringify({
      capability: encodeCapability(
        authCapability,
        keys.issuerPrivateKey ?? relay.issuerPrivateKey
      ),
      publicKeyJwk: relay.browser.jwk,
      signature: browserProof(
        relay.browser.privateKey,
        challenge,
        authCapability.capabilityId
      ),
      type: "auth",
      v: 1,
      ...extra,
    })
  )
}

const databaseCapability = {
  actions: ["database.logs.read"],
  instanceId: sharedId,
  resourceKind: "database",
} satisfies Partial<RelayBrowserCapabilityV2>

let openedConsoles = 0

// Opens a live console as a page does, keeping the lines of the run it
// shows: a reset starts a run, history for that run fills in older lines,
// and live lines follow.
async function openConsole(relay: TestRelay, live: LiveConsole) {
  // Each from its own login, so none replaces another.
  const { socket } = await authenticate(relay, {
    instanceId: live.id,
    loginSessionId: `login-session-${(openedConsoles += 1)}`,
  })
  let startedAt: string | null = null
  let ready = false
  const lines = new Map<string, RelayConsoleLine>()
  // The run each reset and history frame was for, in arrival order.
  const runs: Array<{ startedAt: string; type: string }> = []
  const checks = new Set<() => void>()
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as {
      lifecycle?: Array<{ time: string }>
      line?: RelayConsoleLine
      lines?: Array<RelayConsoleLine>
      type: string
    }
    const run = frame.lifecycle?.[0]?.time ?? null
    if (frame.type === "ready") ready = true
    if (frame.type === "reset" || frame.type === "history") {
      runs.push({ startedAt: run ?? "", type: frame.type })
    }
    if (frame.type === "reset") {
      startedAt = run
      lines.clear()
    }
    if (
      frame.type === "reset" ||
      (frame.type === "history" && run === startedAt)
    ) {
      for (const line of frame.lines ?? []) lines.set(line.id, line)
    } else if (frame.type === "line" && frame.line) {
      lines.set(frame.line.id, frame.line)
    }
    for (const check of checks) check()
  })
  socket.send(
    JSON.stringify({ instanceId: live.id, type: "console.subscribe", v: 1 })
  )
  const view = {
    socket,
    runs,
    // Shown oldest first, as pages order lines.
    lineIds: () =>
      [...lines.values()]
        .sort((left, right) =>
          (left.timestamp ?? "").localeCompare(right.timestamp ?? "")
        )
        .map((line) => line.id),
    showing: (ids: ReadonlyArray<string>) => ids.every((id) => lines.has(id)),
    // Resolves once `predicate` holds, failing should the socket close
    // first.
    until: (predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const finish = () => {
          checks.delete(check)
          socket.off("close", closed)
        }
        const check = () => {
          if (!predicate()) return
          finish()
          resolve()
        }
        const closed = (code: number) => {
          finish()
          reject(new Error(`The console closed with ${code}`))
        }
        checks.add(check)
        socket.once("close", closed)
        check()
      }),
  }
  await view.until(() => ready)
  return view
}

const relayLogsCapability = {
  actions: ["relay.logs.read"],
  instanceId: relayId,
  resourceKind: "relay",
} satisfies Partial<RelayBrowserCapabilityV2>

function lineTexts(frame: Record<string, unknown>): Array<string> {
  return (frame.lines as Array<{ text: string }>).map((line) => line.text)
}

async function attemptAuthentication(
  relay: TestRelay,
  overrides: {
    capability?: Partial<RelayBrowserCapabilityV2>
    issuerPrivateKey?: KeyObject
    proofPrivateKey?: KeyObject
    socketOrigin?: string
  }
): Promise<{ closed: { code: number; reason: string }; ready: boolean }> {
  const socket = relay.connect(overrides.socketOrigin ?? origin)
  const messages = messageCollector(socket)
  let ready = false
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as Record<string, unknown>
    if (value.type === "auth.ready") ready = true
  })
  const challenge = await messages.next("auth.challenge")
  const closed = messages.closed()
  const authCapability = {
    ...capability({
      capabilityId: "capability-1",
      keyThumbprint: relay.browser.keyThumbprint,
      revision: 1,
    }),
    ...overrides.capability,
  }
  socket.send(
    JSON.stringify({
      capability: encodeCapability(
        authCapability,
        overrides.issuerPrivateKey ?? relay.issuerPrivateKey
      ),
      publicKeyJwk: relay.browser.jwk,
      signature: browserProof(
        overrides.proofPrivateKey ?? relay.browser.privateKey,
        challenge,
        authCapability.capabilityId
      ),
      type: "auth",
      v: 1,
    })
  )
  return { closed: await closed, ready }
}

function capability(input: {
  capabilityId: string
  keyThumbprint: string
  revision: number
}): RelayBrowserCapabilityV2 {
  const issuedAt = Date.now()
  return {
    actions: ["instance.console.read"],
    audience: relayId,
    authorizationRevision: input.revision,
    capabilityId: input.capabilityId,
    expiresAt: issuedAt + 30_000,
    instanceId: "instance-test",
    issuedAt,
    issuer: "hearth-test",
    issuerGeneration: 1,
    keyThumbprint: input.keyThumbprint,
    loginSessionId: "login-session-test",
    operation: "console",
    origin,
    path: null,
    subject: "user-test",
    version: 2,
  }
}

function encodeCapability(
  capability: RelayBrowserCapabilityV2,
  privateKey: KeyObject
): string {
  const encoded = Buffer.from(JSON.stringify(capability)).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}

function browserProof(
  privateKey: KeyObject,
  challenge: Record<string, unknown>,
  capabilityId: string
): string {
  const transcript = relayBrowserProofTranscript(
    {
      capabilityId,
      expiresAt: numberField(challenge, "expiresAt"),
      nonce: stringField(challenge, "nonce"),
      relayId: stringField(challenge, "relayId"),
      sessionId: stringField(challenge, "sessionId"),
    },
    relayBrowserConsoleProtocol
  )
  return sign("sha256", Buffer.from(transcript), {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  }).toString("base64url")
}

function messageCollector(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = []
  const waiters: Array<{
    reject: (cause: Error) => void
    resolve: (value: Record<string, unknown>) => void
    type: string
  }> = []
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as Record<string, unknown>
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.type === value.type
    )
    const waiter = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : null
    if (waiter) waiter.resolve(value)
    else queued.push(value)
  })
  socket.on("error", (cause) => {
    for (const waiter of waiters.splice(0)) waiter.reject(cause)
  })
  return {
    closed: () =>
      boundedPromise<{ code: number; reason: string }>((resolve) => {
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      }),
    next: (type: string) => {
      const existingIndex = queued.findIndex((value) => value.type === type)
      if (existingIndex >= 0) {
        return Promise.resolve(queued.splice(existingIndex, 1)[0]!)
      }
      return boundedPromise<Record<string, unknown>>((resolve, reject) => {
        waiters.push({ reject, resolve, type })
      })
    },
  }
}

function boundedPromise<T>(
  start: (resolve: (value: T) => void, reject: (cause: Error) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Browser socket test timed out")),
      2_000
    )
    timeout.unref()
    start(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timeout)
        reject(cause)
      }
    )
  })
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string") throw new Error(`Expected ${key}`)
  return field
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== "number") throw new Error(`Expected ${key}`)
  return field
}
