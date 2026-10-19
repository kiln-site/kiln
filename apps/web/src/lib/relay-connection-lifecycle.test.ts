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
  RelaySystemUpdate,
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
const auditFakes = vi.hoisted(() => ({
  finished: [] as Array<{ operationId: string; outcome: string }>,
  started: [] as Array<{ operation: string; operationId: string }>,
}))
vi.mock("@/lib/hearth-audit.server", async () => {
  const { Effect } = await import("effect")
  return {
    reconcilePendingRelayChanges: () => Effect.void,
    recordRelayChangeFinished: (input: {
      operationId: string
      outcome: string
    }) => Effect.sync(() => auditFakes.finished.push(input)),
    recordRelayChangeStarted: (input: {
      operation: string
      operationId: string
    }) => Effect.sync(() => auditFakes.started.push(input)),
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
  isRelayUpdating,
  relayBrowserAuthorizationReady,
  relayConnectionBrowserMetadata,
  relayConnectionFailing,
  relayConnectionState,
  relayConnectionNode,
  relayRpc,
  relaySystemUpdates,
  relayUpdateReportState,
} from "@/lib/relay-connection"
import { listPersistedRelays, loadRelayCredentials } from "@/lib/relay-registry"
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

it("fails page reads fast only after a Relay drops, not while it first connects", async () => {
  const fixture = await setupRelayServer()
  try {
    // A first connection after startup is still in progress.
    const first = relayRpc(fixture.endpoint, "relay.snapshot", {}, 1_000)
    expect(relayConnectionFailing(relayId)).toBe(false)
    await first
    expect(relayConnectionFailing(relayId)).toBe(false)

    for (const client of fixture.server.clients) client.terminate()
    await vi.waitFor(() => expect(relayConnectionFailing(relayId)).toBe(true))

    // Reconnecting after the backoff clears it.
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relayConnectionState(relayId).status).toBe("authenticated")
    })
    expect(relayConnectionFailing(relayId)).toBe(false)
  } finally {
    closeRelayConnection(relayId)
    for (const client of fixture.server.clients) client.terminate()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }
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

// Updates are what each Relay reports in its snapshot, so a Hearth replaced
// mid-update learns how they went from the Relays.
const runningUpdate: RelaySystemUpdate = {
  component: "relay",
  error: null,
  finishedAt: null,
  id: "00000000-0000-4000-8000-00000000000a",
  phase: "replace.stopCurrent",
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "running",
  version: "0.1.0",
}

effectIt.effect(
  "keeps a Relay updating while it replaces itself, until it reports the outcome",
  () =>
    withRelayServer(({ disconnect, endpoint, reconnected, reportUpdates }) =>
      Effect.gen(function* () {
        const relayStates: Array<string> = []
        const browserEvents: Array<unknown> = []
        const unsubscribe = subscribeRealtimeChanges((event) => {
          if (event.type === "relay.state") {
            relayStates.push(
              `${event.status}${event.updating ? ":updating" : ""}`
            )
          }
          if (event.type === "relay.snapshot.delta") browserEvents.push(event)
        })
        // This Hearth starts while the Relay is updating.
        reportUpdates([runningUpdate])
        const snapshot = yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        expect(isRelayUpdating(relayId)).toBe(true)
        expect(relaySystemUpdates(relayId)).toEqual([runningUpdate])
        expect(relayUpdateReportState(relayId)).toBe("reporting")
        // Hearth's own updates are for administrators only, so updates stay
        // out of the snapshots browsers receive.
        expect(snapshot).toEqual(pushedSnapshot)
        expect(relayConnectionNode(relayId)).not.toHaveProperty("updates")

        // The Relay being replaced drops its connection and comes back.
        disconnect()
        yield* Effect.promise(() => advanceTimersUntil(reconnected))
        yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        expect(isRelayUpdating(relayId)).toBe(true)

        const succeeded = {
          ...runningUpdate,
          finishedAt: "2026-01-01T00:01:00.000Z",
          status: "succeeded" as const,
        }
        const settled = nextSettledState()
        reportUpdates([succeeded])
        yield* Effect.promise(() => advanceTimersUntil(settled))

        expect(isRelayUpdating(relayId)).toBe(false)
        expect(relaySystemUpdates(relayId)).toEqual([succeeded])
        expect(relayStates).toContain("unreachable:updating")
        expect(relayStates).not.toContain("unreachable")
        expect(relayStates.at(-1)).toBe("connected")
        expect(JSON.stringify(browserEvents)).not.toContain(runningUpdate.id)
        unsubscribe()
      })
    )
)

effectIt.effect("stops showing a Relay that stays away as updating", () =>
  withRelayServer(({ endpoint, reportUpdates, server }) =>
    Effect.gen(function* () {
      reportUpdates([runningUpdate])
      yield* promiseEffect(() =>
        relayRpc(endpoint, "relay.snapshot", {}, 1_000)
      )
      expect(isRelayUpdating(relayId)).toBe(true)

      const away = nextRelayState("unreachable")
      server.close()
      for (const client of server.clients) client.terminate()
      yield* Effect.promise(() => advanceTimersUntil(away))
      expect(isRelayUpdating(relayId)).toBe(true)

      const settled = nextSettledState()
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15 * 60_000))
      yield* Effect.promise(() => settled)
      expect(isRelayUpdating(relayId)).toBe(false)
    })
  )
)

effectIt.effect(
  "reports nothing for a Relay that predates update reports",
  () =>
    withRelayServer(({ endpoint }) =>
      Effect.gen(function* () {
        yield* promiseEffect(() =>
          relayRpc(endpoint, "relay.snapshot", {}, 1_000)
        )
        expect(relaySystemUpdates(relayId)).toBeNull()
        expect(relayUpdateReportState(relayId)).toBe("unsupported")
        expect(isRelayUpdating(relayId)).toBe(false)
      })
    )
)

effectIt.effect(
  "tells a paused Relay it's paused each time Hearth connects to it",
  () =>
    withRelayServer(({ endpoint, requests }) =>
      Effect.gen(function* () {
        vi.mocked(listPersistedRelays).mockResolvedValue([
          { ...endpoint, enabled: false },
        ] as unknown as Awaited<ReturnType<typeof listPersistedRelays>>)
        // Paused while it was away, say, and Hearth has restarted since.
        yield* promiseEffect(() =>
          relayRpc({ ...endpoint, enabled: false }, "relay.snapshot", {})
        )
        yield* promiseEffect(() =>
          vi.waitFor(() =>
            expect(requests).toContainEqual(
              expect.objectContaining({
                operation: "relay.pause.write",
                payload: { paused: true },
              })
            )
          )
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            vi.mocked(listPersistedRelays).mockResolvedValue([])
          )
        )
      )
    )
)

effectIt.effect(
  "tells a Relay again about a resume it never answered, until it takes it",
  () => {
    const pauseWrites: Array<unknown> = []
    let retold: () => void = () => {}
    const tellsAgain = new Promise<void>((resolve) => {
      retold = resolve
    })
    return withRelayServer(
      ({ endpoint }) =>
        Effect.gen(function* () {
          vi.mocked(listPersistedRelays).mockResolvedValue([
            { ...endpoint, enabled: true },
          ] as unknown as Awaited<ReturnType<typeof listPersistedRelays>>)
          yield* promiseEffect(() => relayRpc(endpoint, "relay.snapshot", {}))
          yield* Effect.promise(() => advanceTimersUntil(tellsAgain))
          // Once it has taken the resume, later passes leave it alone.
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(65_000))
          expect(pauseWrites).toEqual([{ paused: false }, { paused: false }])
        }).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              vi.mocked(listPersistedRelays).mockResolvedValue([])
            )
          )
        ),
      (message) => {
        if (message.operation !== "relay.pause.write") return { ok: true }
        pauseWrites.push(message.payload)
        // The first is lost; the next is answered.
        if (pauseWrites.length === 1) return noAnswer
        retold()
        return { paused: false }
      }
    )
  }
)

effectIt.effect(
  "records a person's change in Hearth's audit, and sends a paused Relay none",
  () =>
    withRelayServer(({ endpoint, requests }) =>
      Effect.gen(function* () {
        auditFakes.started.length = 0
        auditFakes.finished.length = 0
        yield* promiseEffect(() =>
          relayRpc(
            endpoint,
            "instance.rename",
            { instanceId: "a".repeat(40), name: "Lobby" },
            1_000,
            "user-a"
          )
        )
        const sent = requests.find(
          (r): r is RelayControlRequestMessage =>
            r.type === "request" && r.operation === "instance.rename"
        )!
        expect(auditFakes.started).toMatchObject([
          { operation: "instance.rename", operationId: sent.operationId },
        ])
        // The outcome is written after the reply, without holding it up.
        yield* promiseEffect(() =>
          vi.waitFor(() =>
            expect(auditFakes.finished).toEqual([
              { operationId: sent.operationId, outcome: "succeeded" },
            ])
          )
        )

        const paused = yield* promiseEffect(() =>
          relayRpc(
            { ...endpoint, enabled: false },
            "instance.action",
            { action: "start", instanceId: "a".repeat(40) },
            1_000,
            "user-a"
          )
        ).pipe(Effect.flip)
        expect(paused).toMatchObject({ code: "relay_paused" })
        expect(
          requests.filter(
            (r) => r.type === "request" && r.operation === "instance.action"
          )
        ).toHaveLength(0)
        // Reads still work.
        yield* promiseEffect(() =>
          relayRpc({ ...endpoint, enabled: false }, "relay.system.inspect", {})
        )
      })
    )
)

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
  "reports a change unknown when Hearth closes the connection it was sent on",
  () =>
    withRelayServer(
      ({ endpoint, requests }) =>
        Effect.gen(function* () {
          const pending = relayRpc(
            endpoint,
            "instance.action",
            { action: "restart", instanceId: "d".repeat(40) },
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
          closeRelayConnection(relayId)
          const closed = yield* promiseEffect(() => pending).pipe(Effect.flip)
          expect(closed).toMatchObject({ outcome: "unknown" })
        }),
      (message) =>
        message.operation === "instance.action" ? noAnswer : { eligible: true }
    )
)

effectIt.effect(
  "reports a change the Relay never received as not run, and a slow one as unknown",
  () =>
    withRelayServer(
      ({ disconnect, endpoint, reconnected, requests }) =>
        Effect.gen(function* () {
          const lost = relayRpc(
            endpoint,
            "instance.action",
            { action: "start", instanceId: "b".repeat(40) },
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
          disconnect()
          yield* Effect.promise(() => advanceTimersUntil(reconnected))
          const notRun = yield* promiseEffect(() =>
            advanceTimersUntil(lost)
          ).pipe(Effect.flip)
          expect(notRun.message).toContain("It didn't run")
          expect(notRun).not.toHaveProperty("outcome")

          const slow = yield* promiseEffect(() =>
            advanceTimersUntil(
              relayRpc(
                endpoint,
                "instance.action",
                { action: "start", instanceId: "c".repeat(40) },
                500
              )
            )
          ).pipe(Effect.flip)
          expect(slow).toMatchObject({ outcome: "unknown" })
        }),
      (message) => {
        if (message.operation === "instance.action") return noAnswer
        if (message.operation === "operation.get") return { status: "unknown" }
        return { eligible: true }
      }
    )
)

function nextRelayState(status: "connected" | "unreachable"): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = subscribeRealtimeChanges((event) => {
      if (event.type === "relay.state" && event.status === status) {
        unsubscribe()
        resolve()
      }
    })
  })
}

function nextSettledState(): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = subscribeRealtimeChanges((event) => {
      if (event.type === "relay.state" && !event.updating) {
        unsubscribe()
        resolve()
      }
    })
  })
}

interface RelayServerFixture {
  cancelled: Promise<void>
  disconnect: () => void
  endpoint: {
    hostname: string
    id: string
    port: number
    useTls: false
  }
  /** Reports updates in later snapshots, and on the current connection. */
  reportUpdates: (updates: ReadonlyArray<RelaySystemUpdate>) => void
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
  let updates: ReadonlyArray<RelaySystemUpdate> | undefined
  let sequence = 1
  const snapshot = (): RelaySnapshot =>
    updates
      ? {
          ...pushedSnapshot,
          node: { ...pushedSnapshot.node, updates: [...updates] },
        }
      : pushedSnapshot
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
    sequence = 1
    authenticateRelaySocket(
      socket,
      relayKeys.privateKey,
      requests,
      snapshot,
      () => {
        resolveCancelled()
      },
      answer
    )
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
    reportUpdates: (next) => {
      updates = next
      sequence += 1
      activeSocket?.send(
        JSON.stringify({
          event: "relay.snapshot.delta",
          id: randomUUID(),
          payload: {
            deletedInstanceIds: [],
            instances: [],
            node: snapshot().node,
          },
          seq: sequence,
          type: "event",
          v: 1,
        })
      )
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
  snapshot: () => RelaySnapshot,
  onCancel: () => void,
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
          payload: snapshot(),
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

function promiseEffect<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Test promise failed"),
  })
}
