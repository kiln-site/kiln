import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { connect } from "node:net"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"
import { WebSocket, WebSocketServer } from "ws"

import {
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlDialPath,
  relayControlDialV1Feature,
  relayControlProtocol,
  relayDialCloseCodes,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlClientMessage,
  RelayDialBinding,
} from "@workspace/contracts"

vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: vi.fn(async () => []),
  loadPersistedRelay: vi.fn(),
  loadRelayCredentials: vi.fn(),
}))
vi.mock("@/lib/sftp-authorization", () => ({
  resolveSftpAuthorization: vi.fn(),
}))
vi.mock("@/lib/hearth-audit.server", async () => {
  const { Effect } = await import("effect")
  return {
    reconcilePendingRelayChanges: () => Effect.void,
    recordRelayChangeFinished: () => Effect.void,
    recordRelayChangeStarted: () => Effect.void,
  }
})
vi.mock("@/lib/authorization-delivery", () => ({
  synchronizeRelayIssuerGeneration: vi.fn(async () => 0),
  synchronizeRelayIssuerGenerationMinimum: vi.fn(async () => 0),
  wakeAuthorizationDelivery: vi.fn(),
}))

import {
  closeRelayConnection,
  relayConnectionOpener,
  relayRpc,
} from "@/lib/relay-connection"
import type { RelayEndpoint } from "@/lib/relay-control-endpoint"
import { handleRelayControlUpgrade } from "@/lib/relay-control-dial.server"
import { loadPersistedRelay, loadRelayCredentials } from "@/lib/relay-registry"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"

const relayId = "relay-control-dial-test"
const relayKeys = generateKeyPairSync("ed25519")
const clientKeys = generateKeyPairSync("ed25519")
const clientId = "hearth-client"

const snapshot = {
  instances: [],
  node: {
    arch: "arm64",
    canProvisionInstances: true,
    capabilities: [],
    connectedAt: "2026-01-01T00:00:00.000Z",
    cpu: { cores: 4, loadPercent: 0 },
    docker: { available: true, version: "test" },
    id: "node-a",
    memory: { totalBytes: 1, usedBytes: 0 },
    name: "Relay test node",
    platform: "linux",
    startedAt: "2026-01-01T00:00:00.000Z",
    storage: { totalBytes: 1, usedBytes: 0 },
    uptimeSeconds: 0,
    version: "test",
  },
}

let hearthOrigin = ""

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.mocked(loadRelayCredentials).mockResolvedValue({
    caCertificatePem: null,
    clientId,
    clientPrivateKeyPem: clientKeys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    clientPublicKeyPem: clientKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    relayPublicKeyPem: relayKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    sendInstallationId: false,
  })
  // Hearth, as Relays dial it.
  const server = createServer()
  server.on("upgrade", (request, socket, head) => {
    if (!handleRelayControlUpgrade(request, socket, head)) socket.destroy()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  hearthOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubEnv("KILN_RELAY_DIAL_URL", hearthOrigin)
  return async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

afterEach(() => {
  closeRelayConnection(relayId)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it("takes a control connection a Relay opened and serves requests over it", async () => {
  // Nothing listens where Hearth would dial the Relay itself.
  const relay = relayAt(await closedPort(), "relay")
  const dialing = await dialHearth()
  const response = await dialing.authenticate()

  // Hearth signed for the challenge it asked for, and says where to dial.
  expect(response.clientId).toBe(clientId)
  expect(response.dial).toEqual({
    url: `${hearthOrigin}${relayControlDialPath}`,
  })
  expect(
    verify(
      null,
      Buffer.from(relayAuthResponseTranscript(dialing.challenge, clientId)),
      clientKeys.publicKey,
      Buffer.from(response.signature, "base64url")
    )
  ).toBe(true)

  const answered = relayRpc(relay, "relay.proxy.read", {})
  const request = await advanceUntil(dialing.nextRequest())
  dialing.answer(request, { mode: "hearth" })
  await expect(advanceUntil(answered)).resolves.toEqual({ mode: "hearth" })
  expect(relayConnectionOpener(relayId)).toBe("relay")
})

it("refuses a challenge it didn't ask for, and a Relay it doesn't know", async () => {
  relayAt(await closedPort(), "relay")
  const replayed = await dialHearth({
    nonce: randomBytes(32).toString("base64url"),
  })
  await expect(advanceUntil(replayed.closed)).resolves.not.toBe(1000)
  expect(replayed.responses).toEqual([])

  // A challenge the Relay made for another Hearth's client.
  const otherClient = await dialHearth({ clientId: "another-hearth-client" })
  await advanceUntil(otherClient.closed)
  expect(otherClient.responses).toEqual([])

  vi.mocked(loadPersistedRelay).mockResolvedValueOnce(null)
  const unknown = await dialHearth()
  await expect(advanceUntil(unknown.closed)).resolves.toBe(
    relayDialCloseCodes.unknownRelay
  )
})

it("closes, rather than throws on, a malformed connection without the protocol", async () => {
  const raw = connect(Number(new URL(hearthOrigin).port), "127.0.0.1")
  await once(raw, "connect")
  raw.on("error", () => undefined)
  raw.resume()
  // An upgrade with no subprotocol, and an unmasked frame right behind it.
  raw.write(
    [
      `GET ${relayControlDialPath} HTTP/1.1`,
      "Host: hearth",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n")
  )
  raw.write(Buffer.from([0x82, 0x00]))
  await advanceUntil(once(raw, "close"))
})

it("still closes a connection in time while its challenge waits to be checked", async () => {
  relayAt(await closedPort(), "relay")
  // As when the database is slow to answer.
  vi.mocked(loadPersistedRelay).mockReturnValueOnce(new Promise(() => {}))
  const waiting = await dialHearth()
  await expect(advanceUntil(waiting.closed)).resolves.toBe(4401)
})

it("keeps the Relay's connection when someone else says they're that Relay", async () => {
  const relay = relayAt(await closedPort(), "relay")
  const dialing = await dialHearth()
  await dialing.authenticate()
  await advanceUntil(until(() => relayConnectionOpener(relayId) === "relay"))

  const forged = await dialHearth({
    nonce: randomBytes(32).toString("base64url"),
  })
  await expect(advanceUntil(forged.closed)).resolves.toBe(4401)

  const answered = relayRpc(relay, "relay.proxy.read", {})
  const request = await advanceUntil(dialing.nextRequest())
  dialing.answer(request, { mode: "hearth" })
  await expect(advanceUntil(answered)).resolves.toEqual({ mode: "hearth" })
})

it("keeps its own connection when it prefers to, and hands over quietly when it prefers the Relay's", async () => {
  const listening = await listeningRelay()
  const relay = relayAt(listening.port, "hearth")
  await advanceUntil(relayRpc(relay, "relay.proxy.read", {}))
  expect(relayConnectionOpener(relayId)).toBe("hearth")

  const refused = await dialHearth()
  await expect(advanceUntil(refused.closed)).resolves.toBe(
    relayDialCloseCodes.duplicate
  )

  const states: Array<string> = []
  const unsubscribe = subscribeRealtimeChanges((event) => {
    if (event.type === "relay.state") states.push(event.status)
  })
  const preferred = relayAt(listening.port, "relay")
  // Hearth learns the preference from the Relay it's asked about.
  await advanceUntil(relayRpc(preferred, "relay.proxy.read", {}))
  const taken = await dialHearth()
  await taken.authenticate()
  await advanceUntil(until(() => relayConnectionOpener(relayId) === "relay"))
  unsubscribe()

  expect(relayConnectionOpener(relayId)).toBe("relay")
  expect(states).not.toContain("unreachable")
  const answered = relayRpc(preferred, "relay.proxy.read", {})
  const request = await advanceUntil(taken.nextRequest())
  taken.answer(request, { mode: "traefik" })
  await expect(advanceUntil(answered)).resolves.toEqual({ mode: "traefik" })
})

it("tries its own connection first when it prefers to, and takes the Relay's once that fails", async () => {
  // Hearth can't reach the Relay.
  relayAt(await closedPort(), "hearth")
  const early = await dialHearth()
  await expect(advanceUntil(early.closed)).resolves.toBe(1013)

  const later = await dialHearth()
  await later.authenticate()
  await advanceUntil(until(() => relayConnectionOpener(relayId) === "relay"))
})

it("opens its own connection when a Relay it prefers to be dialed by doesn't", async () => {
  const listening = await listeningRelay()
  const relay = relayAt(listening.port, "relay")

  await expect(
    advanceUntil(relayRpc(relay, "relay.proxy.read", {}))
  ).resolves.toEqual({ mode: "none" })
  expect(relayConnectionOpener(relayId)).toBe("hearth")
  expect(listening.connections()).toBe(1)
})

function relayAt(port: number, controlDial: "hearth" | "relay"): RelayEndpoint {
  const relay = {
    controlDial,
    hostname: "127.0.0.1",
    id: relayId,
    port,
    useTls: false,
  }
  vi.mocked(loadPersistedRelay).mockResolvedValue(
    relay as unknown as Awaited<ReturnType<typeof loadPersistedRelay>>
  )
  return relay
}

function signedChallenge(dial: RelayDialBinding | undefined) {
  const unsigned: Omit<RelayAuthChallenge, "signature"> = {
    ...(dial ? { dial } : {}),
    expiresAt: Date.now() + 10_000,
    nonce: randomBytes(32).toString("base64url"),
    relayId,
    sessionId: randomUUID(),
    type: "auth.challenge",
    v: 1,
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(relayAuthChallengeTranscript(unsigned)),
      relayKeys.privateKey
    ).toString("base64url"),
  }
}

// A Relay dialing Hearth, as the Relay's dialer does: it answers Hearth's
// hello with a challenge, bound to the nonce unless told otherwise.
async function dialHearth(
  override: { readonly clientId?: string; readonly nonce?: string } = {}
) {
  const socket = new WebSocket(
    `${hearthOrigin.replace("http", "ws")}${relayControlDialPath}`,
    relayControlProtocol
  )
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
    for (const waiter of waiters.splice(0)) waiter()
  })
  const closed = new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code))
  })
  const next = async (type: string) => {
    for (;;) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return messages.splice(index, 1)[0]!
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- waits for the next frame
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  const hello = await advanceUntil(next("dial.hello"))
  const challenge = signedChallenge({
    clientId: override.clientId ?? clientId,
    hearthNonce: override.nonce ?? (hello.nonce as string),
    hearthOrigin,
  })
  socket.send(JSON.stringify(challenge))
  return {
    answer: (request: { readonly id: string }, payload: unknown) => {
      socket.send(
        JSON.stringify({
          id: randomUUID(),
          payload,
          replyTo: request.id,
          type: "response",
          v: 1,
        })
      )
    },
    authenticate: async () => {
      const response = await advanceUntil(next("auth.response"))
      socket.send(JSON.stringify(ready()))
      socket.send(JSON.stringify(snapshotEvent()))
      return response as {
        clientId: string
        dial: unknown
        signature: string
      }
    },
    challenge,
    closed,
    nextRequest: () =>
      next("request") as Promise<{ readonly id: string }>,
    get responses() {
      return messages.filter((message) => message.type === "auth.response")
    },
  }
}

// A Relay Hearth dials, as before Relays could dial it.
async function listeningRelay() {
  let connections = 0
  const server = new WebSocketServer({
    handleProtocols: () => relayControlProtocol,
    port: 0,
  })
  server.on("connection", (socket) => {
    connections += 1
    socket.send(JSON.stringify(signedChallenge(undefined)))
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RelayControlClientMessage
      if (message.type === "auth.response") {
        socket.send(JSON.stringify(ready()))
        socket.send(JSON.stringify(snapshotEvent()))
      } else if (message.type === "request") {
        socket.send(
          JSON.stringify({
            id: randomUUID(),
            payload: { mode: "none" },
            replyTo: message.id,
            type: "response",
            v: 1,
          })
        )
      }
    })
  })
  await once(server, "listening")
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      })
  )
  return {
    connections: () => connections,
    port: (server.address() as AddressInfo).port,
  }
}

function ready() {
  return {
    actions: [],
    clientId,
    features: [relayControlDialV1Feature],
    protocol: relayControlProtocol,
    relayBuild: "test",
    role: "full_access",
    type: "auth.ready",
    v: 1,
  }
}

function snapshotEvent() {
  return {
    event: "relay.snapshot",
    id: randomUUID(),
    payload: snapshot,
    seq: 1,
    type: "event",
    v: 1,
  }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const cleanups: Array<() => Promise<void>> = []
function onCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- polls between I/O turns
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// Lets virtual time pass in small steps, with real I/O between them, until
// the promise settles.
async function advanceUntil<TResult>(
  promise: Promise<TResult>
): Promise<TResult> {
  let settled = false
  const settle = () => {
    settled = true
  }
  promise.then(settle, settle)
  while (!settled) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(100)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return promise
}
