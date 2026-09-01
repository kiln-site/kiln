import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto"
import { once } from "node:events"

import { it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vite-plus/test"
import { WebSocketServer } from "ws"
import type { AddressInfo } from "node:net"
import type { WebSocket } from "ws"

import {
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

import {
  closeRelayConnection,
  relayConnectionBrowserMetadata,
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

afterEach(() => {
  closeRelayConnection(relayId)
  vi.restoreAllMocks()
})

effectIt.effect(
  "authenticates, routes responses, cancels timeouts, and closes cleanly",
  () =>
    withRelayServer(
      ({ cancelled, disconnect, endpoint, reconnected, requests }) =>
        Effect.gen(function* () {
          const activityEvents: Array<string> = []
          const relayStates: Array<"connected" | "unreachable"> = []
          const unsubscribe = subscribeRealtimeChanges((event) => {
            if (event.type === "hearth.invalidate") {
              activityEvents.push(...event.topics)
            }
            if (event.type === "relay.state") relayStates.push(event.status)
          })
          const snapshot = yield* promiseEffect(() =>
            relayRpc(endpoint, "relay.snapshot", {}, 1_000)
          )
          expect(snapshot).toEqual(pushedSnapshot)
          expect(relayConnectionBrowserMetadata(relayId)).toEqual({
            browserOrigin: "https://relay.example.com",
            mode: "hearth",
          })
          expect(requests).toHaveLength(0)
          expect(relayStates).toEqual(["connected"])

          const inspection = yield* promiseEffect(() =>
            relayRpc(endpoint, "relay.system.inspect", {}, 1_000)
          )
          expect(inspection).toEqual({ eligible: true })
          expect(requests).toHaveLength(1)

          yield* promiseEffect(() =>
            relayRpc(
              endpoint,
              "relay.proxy.write",
              { mode: "none" },
              1_000,
              "user-a"
            )
          )
          expect(activityEvents).toEqual(["activity"])

          vi.spyOn(Math, "random").mockReturnValue(0)
          disconnect()
          yield* Effect.promise(() => reconnected)
          const reconnectedSnapshot = yield* promiseEffect(() =>
            relayRpc(endpoint, "relay.snapshot", {}, 1_000)
          )
          expect(reconnectedSnapshot).toEqual(pushedSnapshot)
          expect(relayStates).toEqual(["connected", "unreachable", "connected"])

          const timeout = yield* promiseEffect(() =>
            relayRpc(endpoint, "relay.update.status", { ignored: true }, 20)
          ).pipe(Effect.flip)
          expect(timeout.message).toContain(
            "Relay request timed out after 20ms"
          )
          yield* Effect.promise(() => cancelled)

          closeRelayConnection(relayId)
          expect(relayConnectionState(relayId).status).toBe("disconnected")
          expect(relayStates).toEqual(["connected", "unreachable", "connected"])
          unsubscribe()
        })
    )
)

interface RelayServerFixture {
  cancelled: Promise<void>
  disconnect: () => void
  endpoint: {
    hostname: string
    id: string
    port: number
    useTls: false
  }
  requests: Array<RelayControlClientMessage>
  reconnected: Promise<void>
  server: WebSocketServer
}

function withRelayServer<TResult, TError, TRequirements>(
  use: (
    fixture: RelayServerFixture
  ) => Effect.Effect<TResult, TError, TRequirements>
) {
  return Effect.acquireUseRelease(
    promiseEffect(setupRelayServer),
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

async function setupRelayServer(): Promise<RelayServerFixture> {
  const relayKeys = generateKeyPairSync("ed25519")
  const clientKeys = generateKeyPairSync("ed25519")
  vi.mocked(loadRelayCredentials).mockResolvedValue({
    caCertificatePem: null,
    clientId: "hearth-client",
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

  let resolveCancelled: () => void = () => undefined
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve
  })
  const requests: Array<RelayControlClientMessage> = []
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
    if (connections === 2) resolveReconnected()
    authenticateRelaySocket(socket, relayKeys.privateKey, requests, () => {
      resolveCancelled()
    })
  })
  await once(server, "listening")
  return {
    cancelled,
    disconnect: () => {
      activeSocket?.close(1012, "test reconnect")
    },
    endpoint: {
      hostname: "127.0.0.1",
      id: relayId,
      port: (server.address() as AddressInfo).port,
      useTls: false,
    },
    requests,
    reconnected,
    server,
  }
}

function authenticateRelaySocket(
  socket: WebSocket,
  relayPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  requests: Array<RelayControlClientMessage>,
  onCancel: () => void
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
          clientId: "hearth-client",
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
    if (message.type === "cancel") {
      onCancel()
      return
    }
    if (message.type !== "request") return
    requests.push(message)
    if (message.operation === "relay.update.status") return
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        payload: { eligible: true },
        replyTo: message.id,
        type: "response",
        v: 1,
      })
    )
  })
}

function promiseEffect<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Test promise failed"),
  })
}
