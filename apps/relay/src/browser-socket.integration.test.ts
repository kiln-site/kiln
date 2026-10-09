import { createHash, generateKeyPairSync, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { createServer, request as httpRequest } from "node:http"
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
import type { RelayStateStore } from "./effect/state.js"
import type { RelayIdentity } from "./effect/identity.js"
import type { DockerConsoleSession, DockerDriver } from "./docker.js"
import type { FilesystemDriver } from "./files.js"

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

  it("streams a database's console to a capability for that database", async () => {
    const relay = await startRelay()
    const { messages, socket } = await authenticate(relay, databaseCapability)

    socket.send(
      JSON.stringify({ instanceId: sharedId, type: "console.subscribe", v: 1 })
    )

    const reset = await messages.next("reset")
    expect(reset.instanceId).toBe(sharedId)
    expect(lineTexts(reset)).toEqual([`database container-${sharedId} output`])
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
  readonly port: number
  readonly setAuthority: (authority: {
    issuerGeneration: number
    minimumRevision: number
  }) => void
}

// This server's history is several times the test outbox (2 MiB).
const largeHistoryId = "large-history"
const largeHistoryLines = 1_000

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
  } = {}
): Promise<TestRelay> {
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
          Promise.resolve(consoleSession(id, `server ${id} output`)),
        containerConsoleSession: (id, containerId) =>
          Promise.resolve(consoleSession(id, `database ${containerId} output`)),
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
      }
    ),
    docker: {} as DockerDriver,
    filesystem: {} as FilesystemDriver,
    identity: { fingerprint: relayId } as RelayIdentity,
    runEffect: (effect) => Effect.runPromise(effect),
    server,
    state,
    subscribeSnapshots: () => () => undefined,
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
    nextFileRequest: () =>
      new Promise<void>((resolve) => {
        fileRequests.push(resolve)
      }),
    port: address.port,
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

const databaseCapability = {
  actions: ["database.logs.read"],
  instanceId: sharedId,
  resourceKind: "database",
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
