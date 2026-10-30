import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto"
import { once } from "node:events"

import { it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"
import { WebSocketServer } from "ws"
import type { AddressInfo } from "node:net"
import type { WebSocket } from "ws"

import {
  relayBrowserCapabilityV2Feature,
  relayAuthChallengeTranscript,
  relayControlProtocol,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlClientMessage,
  RelaySnapshot,
} from "@workspace/contracts"

vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: vi.fn(async () => []),
  loadRelayCredentials: vi.fn(),
}))
vi.mock("@/lib/sftp-authorization", () => ({
  resolveSftpAuthorization: vi.fn(),
}))
const authorizationFakes = vi.hoisted(() => ({
  synchronize: vi.fn(),
  synchronizeMinimum: vi.fn(),
  wake: vi.fn(),
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
  synchronizeRelayIssuerGeneration: authorizationFakes.synchronize,
  synchronizeRelayIssuerGenerationMinimum:
    authorizationFakes.synchronizeMinimum,
  wakeAuthorizationDelivery: authorizationFakes.wake,
}))

import {
  closeRelayConnection,
  relayConnectionState,
  relayRpc,
} from "@/lib/relay-connection"
import { loadRelayCredentials } from "@/lib/relay-registry"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"

const relayId = "relay-connection-effect-test"
const pushedSnapshot = {
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
  relay: {
    browserOrigin: "https://relay.example.com",
    id: "r".repeat(43),
    name: "Relay test node",
    proxyMode: "hearth",
    sftp: {
      developmentAuthentication: false,
      host: "relay.example.com",
      hostKeyFingerprint: "SHA256:test",
      port: 2022,
      publication: "published",
    },
    tls: null,
  },
} satisfies RelaySnapshot

// Fake only timeouts: Effect's scheduler (setImmediate) and the real ws/ed25519
// handshake keep running, while reconnect backoff, request deadlines, and the
// readiness retry wait for virtual time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  authorizationFakes.synchronize.mockReset().mockResolvedValue(3)
  authorizationFakes.synchronizeMinimum.mockReset().mockResolvedValue(4)
  authorizationFakes.wake.mockReset()
})

afterEach(() => {
  // Each test starts as a fresh Hearth process.
  closeRelayConnection(relayId)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("drops a Relay that stops answering on a socket that stays open", async () => {
  const fixture = await setupRelayServer()
  const relayStates: Array<"connected" | "unreachable"> = []
  const unsubscribe = subscribeRealtimeChanges((event) => {
    if (event.type === "relay.state") relayStates.push(event.status)
  })
  try {
    await relayRpc(fixture.endpoint, "relay.snapshot", {}, 1_000)

    // A Relay that answers pings stays connected however quiet it is.
    await advanceTimersWithIo(90_000)
    expect(relayConnectionState(relayId).status).toBe("authenticated")

    // Stalled, as under memory pressure: the socket stays open, but nothing
    // is read from it or answered.
    for (const client of fixture.server.clients) client.pause()
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1_000) {
      if (relayConnectionState(relayId).status !== "authenticated") break
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
      await advanceTimersWithIo(1_000)
    }
    expect(relayConnectionState(relayId)).toMatchObject({
      lastError: "Relay stopped responding",
      status: "unreachable",
    })
    expect(relayStates).toEqual(["connected", "unreachable"])
  } finally {
    unsubscribe()
    closeRelayConnection(relayId)
    for (const client of fixture.server.clients) client.terminate()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }
})

effectIt.effect(
  "learns how a change went after the connection that sent it dropped",
  () => {
    let applied: string | undefined
    return withRelayServer(
      ({ disconnect, endpoint, reconnected, requests }) =>
        Effect.gen(function* () {
          const action = relayRpc(
            endpoint,
            "instance.action",
            { action: "stop", instanceId: "a".repeat(40) },
            30_000
          )
          yield* Effect.promise(() =>
            advanceTimersUntil(
              new Promise<void>((resolve) => {
                const check = () =>
                  requests.some(
                    (r) =>
                      r.type === "request" && r.operation === "instance.action"
                  )
                    ? resolve()
                    : setImmediate(check)
                check()
              })
            )
          )
          const sent = requests.find(
            (r): r is RelayControlRequestMessage =>
              r.type === "request" && r.operation === "instance.action"
          )!
          applied = sent.operationId
          // The Relay applies the stop, but the reply is lost with the
          // connection.
          disconnect()
          yield* Effect.promise(() => advanceTimersUntil(reconnected))

          const result = yield* promiseEffect(() => advanceTimersUntil(action))
          expect(result).toEqual({ stopped: true })
          const lookups = requests.filter(
            (r): r is RelayControlRequestMessage =>
              r.type === "request" && r.operation === "operation.get"
          )
          expect(lookups.at(-1)?.payload).toEqual({
            operationId: sent.operationId,
          })
          // It was looked up, never sent again.
          expect(
            requests.filter(
              (r) => r.type === "request" && r.operation === "instance.action"
            )
          ).toHaveLength(1)
        }),
      (message) => {
        if (message.operation === "instance.action") return noAnswer
        if (message.operation === "operation.get") {
          const { operationId } = message.payload as { operationId: string }
          return operationId === applied
            ? { result: { stopped: true }, status: "succeeded" }
            : { status: "unknown" }
        }
        return { eligible: true }
      }
    )
  }
)

effectIt.effect(
  "reports a change unknown when the Relay that may have run it forgot it",
  () =>
    withRelayServer(
      ({ disconnect, endpoint, journal, reconnected, requests }) =>
        Effect.gen(function* () {
          const lost = relayRpc(
            endpoint,
            "instance.action",
            { action: "stop", instanceId: "e".repeat(40) },
            30_000
          )
          yield* Effect.promise(() =>
            advanceTimersUntil(
              new Promise<void>((resolve) => {
                const check = () =>
                  requests.some(
                    (r) =>
                      r.type === "request" && r.operation === "instance.action"
                  )
                    ? resolve()
                    : setImmediate(check)
                check()
              })
            )
          )
          // The Relay's state is rebuilt before it answers: it would say it
          // never saw the change, though it may have run it.
          journal.id = "journal-b"
          disconnect()
          yield* Effect.promise(() => advanceTimersUntil(reconnected))

          const forgotten = yield* promiseEffect(() =>
            advanceTimersUntil(lost)
          ).pipe(Effect.flip)
          expect(forgotten).toMatchObject({ outcome: "unknown" })
          expect(forgotten.message).not.toContain("It didn't run")
        }),
      (message) => {
        if (message.operation === "instance.action") return noAnswer
        if (message.operation === "operation.get") return { status: "unknown" }
        return { eligible: true }
      }
    )
)

interface RelayServerFixture {
  disconnect: () => void
  endpoint: {
    hostname: string
    id: string
    port: number
    useTls: false
  }
  /** The Relay's journal, which a rebuilt state replaces. */
  journal: { id: string }
  requests: Array<RelayControlClientMessage>
  reconnected: Promise<void>
  server: WebSocketServer
}

/** What the fake Relay answers a request with; `noAnswer` leaves it hanging. */
type RelayAnswer = (message: RelayControlRequestMessage) => unknown

const noAnswer = Symbol("noAnswer")

type RelayControlRequestMessage = Extract<
  RelayControlClientMessage,
  { type: "request" }
>

function withRelayServer<TResult, TError, TRequirements>(
  use: (
    fixture: RelayServerFixture
  ) => Effect.Effect<TResult, TError, TRequirements>,
  answer?: RelayAnswer
) {
  return Effect.acquireUseRelease(
    promiseEffect(() => setupRelayServer(answer)),
    use,
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) client.terminate()
            server.close(() => resolve())
          })
      )
  )
}

async function setupRelayServer(
  answer?: RelayAnswer
): Promise<RelayServerFixture> {
  const relayKeys = generateKeyPairSync("ed25519")
  const clientKeys = generateKeyPairSync("ed25519")
  vi.mocked(loadRelayCredentials).mockResolvedValue({
    caCertificatePem: null,
    clientId: "hearth-client",
    sendInstallationId: true,
    clientPrivateKeyPem: clientKeys.privateKey
      .export({
        format: "pem",
        type: "pkcs8",
      })
      .toString(),
    clientPublicKeyPem: clientKeys.publicKey
      .export({
        format: "pem",
        type: "spki",
      })
      .toString(),
    relayPublicKeyPem: relayKeys.publicKey
      .export({
        format: "pem",
        type: "spki",
      })
      .toString(),
  })

  const requests: Array<RelayControlClientMessage> = []
  const journal = { id: "journal-a" }
  let activeSocket: WebSocket | null = null
  let connections = 0
  let resolveReconnected: () => void = () => undefined
  const reconnected = new Promise<void>((resolve) => {
    resolveReconnected = resolve
  })
  const server = new WebSocketServer({
    handleProtocols: () => relayControlProtocol,
    port: 0,
  })
  server.on("connection", (socket) => {
    activeSocket = socket
    connections += 1
    if (connections === 2) {
      socket.close(1013, "Relay is still restarting")
      return
    }
    if (connections === 3) resolveReconnected()
    authenticateRelaySocket(
      socket,
      relayKeys.privateKey,
      journal,
      requests,
      answer
    )
  })
  await once(server, "listening")
  return {
    disconnect: () => {
      activeSocket?.close(1012, "test reconnect")
    },
    endpoint: {
      hostname: "127.0.0.1",
      id: relayId,
      port: (server.address() as AddressInfo).port,
      useTls: false,
    },
    journal,
    requests,
    reconnected,
    server,
  }
}

function authenticateRelaySocket(
  socket: WebSocket,
  relayPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  journal: { readonly id: string },
  requests: Array<RelayControlClientMessage>,
  answer?: RelayAnswer
): void {
  const unsignedChallenge: Omit<RelayAuthChallenge, "signature"> = {
    expiresAt: Date.now() + 10_000,
    nonce: randomBytes(32).toString("base64url"),
    relayId,
    sessionId: randomUUID(),
    type: "auth.challenge",
    v: 1,
  }
  socket.send(
    JSON.stringify({
      ...unsignedChallenge,
      signature: sign(
        null,
        Buffer.from(relayAuthChallengeTranscript(unsignedChallenge)),
        relayPrivateKey
      ).toString("base64url"),
    })
  )
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as RelayControlClientMessage
    if (message.type === "auth.response") {
      socket.send(
        JSON.stringify({
          actions: [],
          browserIssuerGeneration: 3,
          clientId: "hearth-client",
          features: [relayBrowserCapabilityV2Feature],
          journalId: journal.id,
          protocol: relayControlProtocol,
          relayBuild: "test",
          role: "full_access",
          type: "auth.ready",
          v: 1,
        })
      )
      socket.send(
        JSON.stringify({
          event: "relay.snapshot",
          id: randomUUID(),
          payload: pushedSnapshot,
          seq: 1,
          type: "event",
          v: 1,
        })
      )
      return
    }
    if (message.type !== "request") return
    requests.push(message)
    if (message.journalId !== undefined && message.journalId !== journal.id) {
      socket.send(
        JSON.stringify({
          code: "journal_changed",
          id: randomUUID(),
          message: "This Relay's state was rebuilt since that change was sent",
          replyTo: message.id,
          retryable: false,
          type: "error",
          v: 1,
        })
      )
      return
    }
    // Never answered, so requests can time out.
    if (message.operation === "relay.update.status") return
    const payload = answer ? answer(message) : { eligible: true }
    if (payload === noAnswer) return
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        payload,
        replyTo: message.id,
        type: "response",
        v: 1,
      })
    )
  })
}

// Advance virtual time in small steps, yielding a real event-loop turn between
// steps so socket I/O triggered by fired timers can land, until the promise
// settles.
async function advanceTimersUntil<TResult>(
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

// Advance virtual time in small steps, yielding real event-loop turns between
// them so pings and pongs can cross the socket.
async function advanceTimersWithIo(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(500)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function promiseEffect<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Test promise failed"),
  })
}
