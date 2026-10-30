import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"
import { connect, createServer as createTcpServer } from "node:net"

import { createWebSocketStream, WebSocket } from "ws"

import {
  relayAuthChallengeTranscript,
  relayControlDialPath,
  relayControlDialV1Feature,
  relayControlProtocol,
  relayDialCloseCodes,
  relayTunnelPath,
  relayTunnelProtocol,
  relayTunnelTokenHeader,
} from "@workspace/contracts"
import type { RelayAuthChallenge, RelayDialBinding } from "@workspace/contracts"

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
import { openRelayTunnel } from "@/lib/relay-tunnel.server"
import { loadPersistedRelay, loadRelayCredentials } from "@/lib/relay-registry"

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

it("takes a tunnel only for a token it asked for, and carries bytes through it", async () => {
  const tunnelTo = (token?: string) =>
    new WebSocket(
      `${hearthOrigin.replace("http", "ws")}${relayTunnelPath}`,
      relayTunnelProtocol,
      token ? { headers: { [relayTunnelTokenHeader]: token } } : {}
    )
  const refusal = async (socket: WebSocket) =>
    (
      (await advanceUntil(once(socket, "unexpected-response"))) as [
        unknown,
        { readonly statusCode: number },
      ]
    )[1].statusCode
  relayAt(await closedPort(), "relay")
  // Hearth waits for no tunnel, so it takes none.
  expect(await refusal(tunnelTo(randomBytes(32).toString("base64url")))).toBe(
    401
  )

  // The Relay's listener, here one that echoes.
  const listener = createTcpServer((socket) => socket.pipe(socket))
  listener.listen(0, "127.0.0.1")
  await once(listener, "listening")
  onCleanup(
    () => new Promise<void>((resolve) => listener.close(() => resolve()))
  )
  const relay = relayAt(await closedPort(), "relay")
  const dialing = await dialHearth()
  await dialing.authenticate()
  const opened = openRelayTunnel(relay)
  const request = (await advanceUntil(dialing.nextRequest())) as {
    readonly id: string
    readonly operation: string
    readonly payload: { readonly token: string }
  }
  expect(request.operation).toBe("relay.tunnel.open")
  // While Hearth waits for one, others can't take its place, named or not.
  expect(await refusal(tunnelTo())).toBe(401)
  expect(await refusal(tunnelTo(randomBytes(32).toString("base64url")))).toBe(
    401
  )
  // As the Relay does: open the tunnel named for it, carry the listener.
  const tunnel = tunnelTo(request.payload.token)
  await advanceUntil(once(tunnel, "open"))
  const local = connect((listener.address() as AddressInfo).port, "127.0.0.1")
  await advanceUntil(once(local, "connect"))
  const remote = createWebSocketStream(tunnel)
  remote.pipe(local).pipe(remote)
  dialing.answer(request, { tls: false })

  const stream = await advanceUntil(opened)
  stream.write("through the tunnel")
  const [echoed] = (await advanceUntil(once(stream, "data"))) as [Buffer]
  expect(echoed.toString()).toBe("through the tunnel")
  stream.destroy()
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
      next("request") as Promise<{
        readonly id: string
        readonly operation?: string
        readonly payload?: unknown
      }>,
    get responses() {
      return messages.filter((message) => message.type === "auth.response")
    },
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
