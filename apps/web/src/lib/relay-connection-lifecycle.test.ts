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
// An in-memory cache stands in for Redis so update windows can outlive the
// process-local registry, as they do when a batched update replaces Hearth.
vi.mock("@/effect/cache", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/effect/cache")>()
  const { Effect, Layer } = await import("effect")
  const entries = new Map<string, string>()
  return {
    ...original,
    AppCacheLive: Layer.succeed(original.AppCache)({
      backend: "redis-protocol",
      enabled: true,
      get: (key) => Effect.sync(() => entries.get(key)),
      remove: (key) =>
        Effect.sync(() => {
          entries.delete(key)
        }),
      set: (key, value) =>
        Effect.sync(() => {
          entries.set(key, value)
        }),
    }),
  }
})
vi.mock("@/lib/sftp-authorization", () => ({
  resolveSftpAuthorization: vi.fn(),
}))
const authorizationFakes = vi.hoisted(() => ({
  synchronize: vi.fn(),
  synchronizeMinimum: vi.fn(),
  wake: vi.fn(),
}))
vi.mock("@/lib/authorization-delivery", () => ({
  synchronizeRelayIssuerGeneration: authorizationFakes.synchronize,
  synchronizeRelayIssuerGenerationMinimum:
    authorizationFakes.synchronizeMinimum,
  wakeAuthorizationDelivery: authorizationFakes.wake,
}))

import {
  clearRelayUpdating,
  closeRelayConnection,
  isRelayUpdating,
  markRelayUpdating,
  relayBrowserAuthorizationReady,
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

// Update operation statuses the fake Relay reports, keyed by operation ID.
const updateOperations = new Map<string, "failed" | "running" | "succeeded">()

// Fake only timeouts: Effect's scheduler (setImmediate) and the real ws/ed25519
// handshake keep running, while reconnect backoff, request deadlines, and the
// readiness retry wait for virtual time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  authorizationFakes.synchronize.mockReset().mockResolvedValue(3)
  authorizationFakes.synchronizeMinimum.mockReset().mockResolvedValue(4)
  authorizationFakes.wake.mockReset()
  updateOperations.clear()
})

afterEach(() => {
  for (const operationId of ["update-a", "update-b"]) {
    clearRelayUpdating(relayId, operationId)
  }
  closeRelayConnection(relayId)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

effectIt.effect(
  "authenticates, retries a failed reconnect, routes responses, and closes cleanly",
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

          disconnect()
          yield* Effect.promise(() => advanceTimersUntil(reconnected))
          const reconnectedSnapshot = yield* promiseEffect(() =>
            relayRpc(endpoint, "relay.snapshot", {}, 1_000)
          )
          expect(reconnectedSnapshot).toEqual(pushedSnapshot)
          expect(relayStates[0]).toBe("connected")
          expect(relayStates.at(-1)).toBe("connected")
          expect(relayStates).toContain("unreachable")

          const timeout = yield* promiseEffect(() =>
            advanceTimersUntil(
              relayRpc(endpoint, "relay.update.status", { ignored: true }, 500)
            )
          ).pipe(Effect.flip)
          expect(timeout.message).toContain(
            "Relay request timed out after 500ms"
          )
          yield* Effect.promise(() => cancelled)

          closeRelayConnection(relayId)
          expect(relayConnectionState(relayId).status).toBe("disconnected")
          expect(relayStates.at(-1)).toBe("connected")
          unsubscribe()
        })
    )
)

effectIt.effect(
  "keeps a Relay updating across reconnects until its operation settles",
  () =>
    withRelayServer(({ disconnect, endpoint, reconnected }) =>
      Effect.gen(function* () {
        const relayStates: Array<string> = []
        const unsubscribe = subscribeRealtimeChanges((event) => {
          if (event.type === "relay.state") {
            relayStates.push(
              `${event.status}${event.updating ? ":updating" : ""}`
            )
          }
        })
        yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        updateOperations.set("update-a", "running")
        markRelayUpdating(relayId, {
          id: "update-a",
          startedAt: new Date().toISOString(),
        })

        // The control socket can drop and return to the Relay being replaced.
        disconnect()
        yield* Effect.promise(() => advanceTimersUntil(reconnected))
        yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000))
        expect(isRelayUpdating(relayId)).toBe(true)

        updateOperations.set("update-a", "succeeded")
        yield* Effect.promise(() =>
          advanceTimersUntil(
            new Promise<void>((resolve) => {
              const unsubscribeSettled = subscribeRealtimeChanges((event) => {
                if (event.type === "relay.state" && !event.updating) {
                  unsubscribeSettled()
                  resolve()
                }
              })
            })
          )
        )

        expect(isRelayUpdating(relayId)).toBe(false)
        expect(relayStates[0]).toBe("connected")
        expect(relayStates[1]).toBe("connected:updating")
        expect(relayStates).toContain("unreachable:updating")
        expect(relayStates).not.toContain("unreachable")
        expect(relayStates.at(-1)).toBe("connected")
        unsubscribe()
      })
    )
)

it("keeps a newer update window when an older operation settles", () => {
  const startedAt = new Date().toISOString()
  markRelayUpdating(relayId, { id: "update-a", startedAt })
  markRelayUpdating(relayId, { id: "update-b", startedAt })

  clearRelayUpdating(relayId, "update-a")
  expect(isRelayUpdating(relayId)).toBe(true)

  clearRelayUpdating(relayId, "update-b")
  expect(isRelayUpdating(relayId)).toBe(false)
})

it("does not reopen an update window after its deadline", () => {
  const relayStates: Array<string> = []
  const unsubscribe = subscribeRealtimeChanges((event) => {
    if (event.type === "relay.state") relayStates.push(event.status)
  })
  markRelayUpdating(relayId, {
    id: "update-a",
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  })

  expect(isRelayUpdating(relayId)).toBe(false)
  expect(relayStates).toEqual([])
  unsubscribe()
})

effectIt.effect(
  "restores an update window when Hearth restarts mid-update",
  () =>
    withRelayServer(({ endpoint }) =>
      Effect.gen(function* () {
        updateOperations.set("update-a", "running")
        markRelayUpdating(relayId, {
          id: "update-a",
          startedAt: new Date().toISOString(),
        })
        yield* Effect.promise(() => nextEventLoopTurn())
        // A replaced Hearth starts without windows or Relay connections.
        globalThis.kilnRelayUpdates?.get(relayId)?.watcher.interruptUnsafe()
        globalThis.kilnRelayUpdates?.clear()
        expect(isRelayUpdating(relayId)).toBe(false)

        yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        yield* Effect.promise(() => nextEventLoopTurn())
        expect(isRelayUpdating(relayId)).toBe(true)

        updateOperations.set("update-a", "succeeded")
        yield* Effect.promise(() =>
          advanceTimersUntil(
            new Promise<void>((resolve) => {
              const unsubscribe = subscribeRealtimeChanges((event) => {
                if (event.type === "relay.state" && !event.updating) {
                  unsubscribe()
                  resolve()
                }
              })
            })
          )
        )
        expect(isRelayUpdating(relayId)).toBe(false)
      })
    )
)

it("reports a Relay unreachable once its update window expires", async () => {
  const relayStates: Array<string> = []
  const unsubscribe = subscribeRealtimeChanges((event) => {
    if (event.type === "relay.state" && event.relayId === relayId) {
      relayStates.push(`${event.status}${event.updating ? ":updating" : ""}`)
    }
  })
  // A restored window keeps the deadline of the operation's start.
  markRelayUpdating(relayId, {
    id: "update-a",
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  })
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000)
  expect(isRelayUpdating(relayId)).toBe(true)

  await vi.advanceTimersByTimeAsync(1_000)
  expect(isRelayUpdating(relayId)).toBe(false)
  expect(relayStates).toEqual(["unreachable:updating", "unreachable"])
  unsubscribe()
})

it("settles failed generation readiness and replaces it for retry", async () => {
  let rejectSynchronization: (cause: Error) => void = () => undefined
  let markSynchronizationStarted: () => void = () => undefined
  const synchronizationStarted = new Promise<void>((resolve) => {
    markSynchronizationStarted = resolve
  })
  authorizationFakes.synchronize
    .mockImplementationOnce(() => {
      markSynchronizationStarted()
      return new Promise<number>((_resolve, reject) => {
        rejectSynchronization = reject
      })
    })
    .mockResolvedValueOnce(5)
  const fixture = await setupRelayServer()
  try {
    const connecting = relayRpc(fixture.endpoint, "relay.snapshot", {}, 1_000)
    await synchronizationStarted
    const initial = relayBrowserAuthorizationReady(relayId, 3)
    rejectSynchronization(new Error("generation database unavailable"))
    await expect(initial).rejects.toThrow("generation database unavailable")
    await connecting

    const retried = relayBrowserAuthorizationReady(relayId, 3)
    // The retry is jittered within 1-3 s.
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(retried).resolves.toBe(5)
  } finally {
    closeRelayConnection(relayId)
    for (const client of fixture.server.clients) client.terminate()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }
})

it("advances a newer persisted generation on the same control socket", async () => {
  const fixture = await setupRelayServer()
  try {
    await relayRpc(fixture.endpoint, "relay.snapshot", {}, 1_000)
    await expect(relayBrowserAuthorizationReady(relayId, 3)).resolves.toBe(3)
    expect(authorizationFakes.synchronizeMinimum).not.toHaveBeenCalled()

    await expect(relayBrowserAuthorizationReady(relayId, 4)).resolves.toBe(4)
    expect(authorizationFakes.synchronizeMinimum).toHaveBeenCalledWith(
      relayId,
      4
    )
  } finally {
    closeRelayConnection(relayId)
    for (const client of fixture.server.clients) client.terminate()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }
})

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
    if (connections === 2) {
      socket.close(1013, "Relay is still restarting")
      return
    }
    if (connections === 3) resolveReconnected()
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
          browserIssuerGeneration: 3,
          clientId: "hearth-client",
          features: [relayBrowserCapabilityV2Feature],
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
    if (message.operation === "relay.update.status") {
      const { operationId } = message.payload as { operationId?: string }
      const status = operationId ? updateOperations.get(operationId) : undefined
      if (!status) return
      socket.send(
        JSON.stringify({
          id: randomUUID(),
          payload: { status },
          replyTo: message.id,
          type: "response",
          v: 1,
        })
      )
      return
    }
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

function nextEventLoopTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function promiseEffect<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Test promise failed"),
  })
}
