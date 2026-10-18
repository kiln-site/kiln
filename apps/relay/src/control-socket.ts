import {
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import { Deferred, Effect, Fiber, Option, Schema } from "effect"
import type { Effect as EffectType } from "effect"
import { WebSocket, WebSocketServer } from "ws"

import {
  RelayControlClientMessageSchema,
  relayAuthenticationWindowMs,
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayBrowserCapabilityV2Feature,
  relayBrowserLeaseRenewalV1Feature,
  relayControlDeadlineMs,
  relayControlMaxFrameBytes,
  relayControlRequestTimeoutMs,
  relayControlProtocol,
  relayConsoleResourcesV1Feature,
  relayAppsV1Feature,
  relayLogsV1Feature,
  relayProxyConfigurationV1Feature,
  relayHostFilesV1Feature,
  relayRestartV1Feature,
  relayResourcesV1Feature,
  relayFilePutV1Feature,
  appIdFromFileRoot,
  isRelayFileRoot,
  relayFileRequestReplayV1Feature,
  relaySnapshotDeltaFeature,
  relaySnapshotNodeResourcesFeature,
  isAuditedRelayControlOperation,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayAuthReady,
  RelayControlError,
  RelayControlEvent,
  RelayControlRequest,
  RelayControlResponse,
  RelayControlOperation,
  RelaySnapshot,
} from "@workspace/contracts"

import { RelayNotFoundError } from "./effect/errors.js"
import {
  reportRelayError,
  traceParentSpan,
  traceRelayPromise,
} from "./effect/runtime.js"
import {
  actionsForRole,
  fileMutationAction,
  isActionAllowed,
} from "./permissions.js"
import { relayBuildLabel } from "./build-info.js"
import { isSourceAllowed } from "./source-policy.js"
import { createRelaySnapshotDelta } from "./snapshot-delta.js"
import { requestUrl } from "./request-url.js"
import type { RelayAction } from "./permissions.js"
import type { RelayIdentity } from "./effect/identity.js"
import type { RelayClientGrant, RelayStateStore } from "./effect/state.js"
import type { Server } from "node:http"

const HEARTBEAT_INTERVAL_MS = 15_000
// Slow-consumer bound. Allows one full-size control frame to be in flight so
// a large (but accepted) response does not look like a stuck peer.
const MAX_BUFFERED_BYTES = 2 * relayControlMaxFrameBytes
const MAX_IN_FLIGHT_REQUESTS = 32
const MAX_CONTROL_SESSIONS = 128
const MAX_CONTROL_SESSIONS_PER_CLIENT = 4

export interface ControlSocketOptions {
  // Saves the installation ID a full-access Hearth authenticated with. The
  // session is ready only once this settles; it reports its own failures.
  readonly adoptInstallationId?: (installationId: string) => Promise<void>
  readonly execute: (
    request: RelayControlRequest,
    client: RelayClientGrant,
    signal: AbortSignal,
    requestHearth: (
      operation: RelayControlOperation,
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>
  ) => Promise<unknown>
  readonly identity: RelayIdentity
  readonly initialSnapshot: () => Promise<unknown>
  readonly subscribeSnapshots: (
    listener: (snapshot: unknown) => void
  ) => () => void
  readonly runEffect: <T, E>(effect: EffectType.Effect<T, E>) => Promise<T>
  readonly server: Server
  readonly state: RelayStateStore["Service"]
}

export interface ControlSocketServer {
  readonly close: () => Promise<void>
  readonly requestClients: (
    operation: RelayControlOperation,
    payload: unknown,
    timeoutMs?: number
  ) => Promise<ReadonlyArray<{ clientId: string; payload: unknown }>>
  readonly refreshClient: (clientId: string) => void
  readonly revokeClient: (clientId: string) => void
  readonly sessions: ReadonlyMap<string, RelayClientGrant>
}

export function attachControlSocket(
  options: ControlSocketOptions
): ControlSocketServer {
  const sessions = new Map<string, RelayClientGrant>()
  const sockets = new Set<WebSocket>()
  const socketSessions = new WeakMap<WebSocket, string>()
  const authenticatedSockets = new Map<WebSocket, RelayClientGrant>()
  const reverseRequesters = new Map<
    WebSocket,
    (
      operation: RelayControlOperation,
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>
  >()
  const wss = new WebSocketServer({
    clientTracking: false,
    maxPayload: relayControlMaxFrameBytes,
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(relayControlProtocol) ? relayControlProtocol : false,
  })

  options.server.on("upgrade", (request, socket, head) => {
    if (requestUrl(request)?.pathname !== "/v1/socket") return
    const protocols = parseProtocols(request.headers["sec-websocket-protocol"])
    if (!protocols.includes(relayControlProtocol)) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request)
    })
  })

  wss.on("connection", (socket, request) => {
    if (sockets.size >= MAX_CONTROL_SESSIONS) {
      socket.close(1013, "Relay control session capacity reached")
      return
    }
    sockets.add(socket)
    authenticateSocket(
      socket,
      options,
      sessions,
      socketSessions,
      authenticatedSockets,
      reverseRequesters,
      request.socket.remoteAddress
    )
    socket.once("close", () => {
      sockets.delete(socket)
      const sessionId = socketSessions.get(socket)
      if (sessionId) sessions.delete(sessionId)
      authenticatedSockets.delete(socket)
      reverseRequesters.delete(socket)
    })
  })

  const heartbeatFiber = Effect.runFork(
    Effect.sleep(HEARTBEAT_INTERVAL_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const socket of sockets) {
            const tracked = socket as TrackedWebSocket
            if (tracked.kilnAlive === false) {
              socket.terminate()
              continue
            }
            tracked.kilnAlive = false
            socket.ping()
          }
        })
      ),
      Effect.forever
    )
  )

  return {
    close: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Fiber.interrupt(heartbeatFiber)
          yield* Effect.sync(() => {
            for (const socket of sockets) {
              socket.close(1001, "Relay shutting down")
            }
          })
          yield* closeWebSocketServerEffect(wss)
        })
      ),
    requestClients: (operation, payload, timeoutMs = 5_000) =>
      Effect.runPromise(
        Effect.forEach(
          [...reverseRequesters.entries()],
          ([socket, request]) =>
            Effect.tryPromise({
              try: () => request(operation, payload, timeoutMs),
              catch: (cause) => cause,
            }).pipe(
              Effect.map((payload) => ({
                clientId: authenticatedSockets.get(socket)?.id ?? "unknown",
                payload,
              })),
              Effect.catch(() => Effect.succeed(null))
            ),
          { concurrency: 16 }
        ).pipe(
          Effect.map((results) =>
            results.filter(
              (result): result is { clientId: string; payload: unknown } =>
                result !== null
            )
          )
        )
      ),
    refreshClient: (clientId) => {
      closeClientSockets(
        authenticatedSockets,
        clientId,
        "Hearth client policy changed"
      )
    },
    revokeClient: (clientId) => {
      closeClientSockets(
        authenticatedSockets,
        clientId,
        "Hearth client was revoked"
      )
    },
    sessions,
  }
}

interface TrackedWebSocket extends WebSocket {
  kilnAlive?: boolean
}

function authenticateSocket(
  socket: WebSocket,
  options: ControlSocketOptions,
  sessions: Map<string, RelayClientGrant>,
  socketSessions: WeakMap<WebSocket, string>,
  authenticatedSockets: Map<WebSocket, RelayClientGrant>,
  reverseRequesters: Map<
    WebSocket,
    (
      operation: RelayControlOperation,
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>
  >,
  peerAddress: string | undefined
): void {
  const unsignedChallenge = {
    expiresAt: Date.now() + relayAuthenticationWindowMs,
    nonce: randomBytes(32).toString("base64url"),
    relayId: options.identity.fingerprint,
    sessionId: randomUUID(),
    type: "auth.challenge" as const,
    v: 1 as const,
  }
  const challenge: RelayAuthChallenge = {
    ...unsignedChallenge,
    signature: sign(
      null,
      Buffer.from(relayAuthChallengeTranscript(unsignedChallenge)),
      options.identity.privateKeyPem
    ).toString("base64url"),
  }
  send(socket, challenge)

  let authenticatedClient: RelayClientGrant | null = null
  let unsubscribeSnapshots: (() => void) | null = null
  let eventSequence = 0
  let previousSnapshot: RelaySnapshot | null = null
  let snapshotDeltasEnabled = false
  let nodeResourceDeltasEnabled = false
  const inFlight = new Map<
    string,
    {
      controller: AbortController
      fiber: Fiber.Fiber<void, unknown> | null
    }
  >()
  const reversePending = new Map<string, Deferred.Deferred<unknown, Error>>()
  let authenticationAttempt: Fiber.Fiber<void, unknown> | null = null
  const authenticationTimeoutFiber = Effect.runFork(
    Effect.sleep(relayAuthenticationWindowMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (!authenticatedClient) {
            socket.close(4401, "Authentication timed out")
          }
        })
      )
    )
  )

  socket.on("pong", () => {
    ;(socket as TrackedWebSocket).kilnAlive = true
  })
  ;(socket as TrackedWebSocket).kilnAlive = true

  socket.on("message", (data, binary) => {
    if (binary) {
      socket.close(4400, "Binary control frames are not supported")
      return
    }
    const decoded = decodeControlClientMessage(data.toString())
    if (Option.isNone(decoded)) {
      sendError(socket, null, "invalid_message", "Invalid control message")
      return
    }
    const message = decoded.value

    if (!authenticatedClient) {
      if (message.type !== "auth.response") {
        socket.close(4401, "Authentication required")
        return
      }
      if (authenticationAttempt) {
        socket.close(4401, "Authentication is already in progress")
        return
      }
      authenticationAttempt = Effect.runFork(
        authenticateClientEffect(
          message.clientId,
          message.signature,
          message.features ?? [],
          message.installationId
        ).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              socket.close(4401, "Authentication failed")
            })
          ),
          Effect.ensuring(
            Effect.sync(() => {
              authenticationAttempt = null
            })
          )
        )
      )
      return
    }

    if (message.type === "auth.response") {
      socket.close(4400, "Session is already authenticated")
      return
    }
    if (message.type === "cancel") {
      const request = inFlight.get(message.replyTo)
      request?.controller.abort()
      request?.fiber?.interruptUnsafe()
      return
    }
    if (message.type === "response" || message.type === "error") {
      const pending = message.replyTo
        ? reversePending.get(message.replyTo)
        : undefined
      if (!pending) return
      reversePending.delete(message.replyTo as string)
      Effect.runFork(
        message.type === "response"
          ? Deferred.succeed(pending, message.payload)
          : Deferred.fail(pending, new Error(message.message))
      )
      return
    }
    if (inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
      sendError(
        socket,
        message.id,
        "too_many_requests",
        "Too many requests are in flight",
        true
      )
      return
    }
    if (inFlight.has(message.id)) {
      sendError(
        socket,
        message.id,
        "duplicate_request",
        "A request with this ID is already in flight"
      )
      return
    }
    const controller = new AbortController()
    const request = {
      controller,
      fiber: null as Fiber.Fiber<void, unknown> | null,
    }
    inFlight.set(message.id, request)
    request.fiber = Effect.runFork(
      Effect.yieldNow.pipe(
        Effect.andThen(
          executeRequestEffect(message, authenticatedClient, controller)
        )
      )
    )
  })

  socket.once("close", () => {
    authenticationTimeoutFiber.interruptUnsafe()
    authenticationAttempt?.interruptUnsafe()
    authenticationAttempt = null
    unsubscribeSnapshots?.()
    unsubscribeSnapshots = null
    for (const request of inFlight.values()) {
      request.controller.abort()
      request.fiber?.interruptUnsafe()
    }
    inFlight.clear()
    for (const pending of reversePending.values()) {
      Effect.runFork(
        Deferred.fail(pending, new Error("Hearth control connection closed"))
      )
    }
    reversePending.clear()
  })

  function authenticateClientEffect(
    clientId: string,
    signature: string,
    features: ReadonlyArray<string>,
    installationId: string | undefined
  ): EffectType.Effect<void, Error> {
    return Effect.gen(function* () {
      if (Date.now() > challenge.expiresAt || authenticatedClient) {
        return yield* controlFailure(
          "Expired or consumed authentication challenge"
        )
      }
      const client = yield* promiseOperation(() =>
        options.runEffect(options.state.findClientById(clientId))
      )
      if (
        !client ||
        !isSourceAllowed(peerAddress, client.sourceCidrs) ||
        !authenticationVerifier({
          challenge: unsignedChallenge,
          client,
          signature,
        })
      ) {
        return yield* controlFailure("Invalid Hearth identity proof")
      }
      snapshotDeltasEnabled = features.includes(relaySnapshotDeltaFeature)
      nodeResourceDeltasEnabled = features.includes(
        relaySnapshotNodeResourcesFeature
      )
      yield* completedAuthenticationEffect(client, installationId)
    })
  }

  function executeRequestEffect(
    request: RelayControlRequest,
    sessionClient: RelayClientGrant,
    controller: AbortController
  ): EffectType.Effect<void> {
    const duration = relayControlRequestTimeoutMs(request, Date.now())
    if (duration === null) {
      return Effect.sync(() => {
        sendError(
          socket,
          request.id,
          "invalid_timeout",
          "Request timeout is invalid"
        )
        inFlight.delete(request.id)
      })
    }
    const operation = Effect.acquireUseRelease(
      Effect.sync(() =>
        Effect.runFork(
          Effect.sleep(duration).pipe(
            Effect.andThen(
              Effect.sync(() => {
                controller.abort()
              })
            )
          )
        )
      ),
      () =>
        Effect.gen(function* () {
          const currentClient = yield* promiseOperation(() =>
            options.runEffect(options.state.findClientById(sessionClient.id))
          )
          if (controller.signal.aborted) {
            return yield* controlFailure("Request timed out")
          }
          if (!currentClient) {
            yield* Effect.sync(() => {
              socket.close(4403, "Hearth client was revoked")
            })
            return
          }
          const action = actionForRequest(request)
          const actions = actionsForRole(
            currentClient.role,
            currentClient.actions
          )
          const issuerInternal =
            request.operation === "browser.authorization.revise"
          if (
            !issuerInternal &&
            (!action || !isActionAllowed(actions, action))
          ) {
            yield* Effect.sync(() => {
              sendError(
                socket,
                request.id,
                "forbidden",
                "Relay permission denied"
              )
            })
            return
          }
          const payload = yield* promiseOperation(() =>
            traceRelayPromise(
              "relay.control.request",
              () =>
                options.execute(
                  request,
                  currentClient,
                  controller.signal,
                  (operation, requestPayload, timeoutMs) =>
                    requestClient(
                      operation,
                      requestPayload,
                      timeoutMs,
                      request.subject
                    )
                ),
              { "relay.operation": request.operation },
              traceParentSpan(request.traceparent)
            )
          )
          if (isAuditedRelayControlOperation(request.operation)) {
            Effect.runFork(
              promiseOperation(() =>
                options.runEffect(
                  options.state.appendAudit({
                    clientId: currentClient.id,
                    details: auditDetailsForRequest(request, payload),
                    event: "control.mutation",
                    id: randomUUID(),
                    occurredAt: Date.now(),
                    requestId: request.id,
                  })
                )
              ).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    reportRelayError(cause, {
                      operation: "relay.control.audit",
                    })
                  })
                )
              )
            )
          }
          const response: RelayControlResponse = {
            id: randomUUID(),
            payload,
            replyTo: request.id,
            type: "response",
            v: 1,
          }
          yield* Effect.sync(() => {
            const serialized = JSON.stringify(response)
            if (Buffer.byteLength(serialized) > relayControlMaxFrameBytes) {
              sendError(
                socket,
                request.id,
                "response_too_large",
                `${request.operation} produced a ${(Buffer.byteLength(serialized) / (1024 * 1024)).toFixed(1)} MiB response, over the ${relayControlMaxFrameBytes / (1024 * 1024)} MiB control message limit`
              )
              return
            }
            sendSerialized(socket, serialized)
          })
        }),
      (timeoutFiber) => Fiber.interrupt(timeoutFiber)
    )
    return operation.pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (controller.signal.aborted) {
            sendError(
              socket,
              request.id,
              "request_cancelled",
              "Relay request was cancelled"
            )
            return
          }
          if (cause instanceof RelayNotFoundError) {
            sendError(socket, request.id, "not_found", cause.message)
            return
          }
          reportRelayError(cause, relayControlErrorContext(request))
          sendError(
            socket,
            request.id,
            "operation_failed",
            relayControlErrorMessage(cause)
          )
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          inFlight.delete(request.id)
        })
      )
    )
  }

  function completedAuthenticationEffect(
    client: RelayClientGrant,
    installationId: string | undefined
  ): EffectType.Effect<void, Error> {
    return Effect.gen(function* () {
      const clientSessionCount = [...authenticatedSockets.values()].filter(
        (authenticated) => authenticated.id === client.id
      ).length
      if (clientSessionCount >= MAX_CONTROL_SESSIONS_PER_CLIENT) {
        yield* Effect.sync(() => {
          socket.close(4429, "Hearth client session capacity reached")
        })
        return
      }
      sessions.set(challenge.sessionId, client)
      socketSessions.set(socket, challenge.sessionId)
      authenticatedSockets.set(socket, client)
      reverseRequesters.set(socket, requestClient)
      // Before the session accepts requests, so none of them, such as a
      // platform backup or an update, runs under the previous ID.
      const adopt = options.adoptInstallationId
      if (adopt && installationId && client.role === "full_access") {
        yield* promiseOperation(() => adopt(installationId)).pipe(Effect.ignore)
      }
      authenticatedClient = client
      yield* Fiber.interrupt(authenticationTimeoutFiber)
      yield* promiseOperation(() =>
        options.runEffect(
          options.state.touchClient(client.id, Date.now(), peerAddress ?? null)
        )
      )
      const browserAuthorization = yield* promiseOperation(() =>
        options.runEffect(
          options.state.reviseBrowserAuthorization(
            client.id,
            [],
            undefined,
            Date.now()
          )
        )
      )
      const ready: RelayAuthReady = {
        actions: actionsForRole(client.role, client.actions),
        browserIssuerGeneration: browserAuthorization.issuerGeneration,
        clientId: client.id,
        features: [
          relayBrowserCapabilityV2Feature,
          relayBrowserLeaseRenewalV1Feature,
          relayFileRequestReplayV1Feature,
          relayConsoleResourcesV1Feature,
          relayAppsV1Feature,
          relayLogsV1Feature,
          relayProxyConfigurationV1Feature,
          relayHostFilesV1Feature,
          relayRestartV1Feature,
          relayResourcesV1Feature,
          relayFilePutV1Feature,
        ],
        protocol: relayControlProtocol,
        relayBuild: relayBuildLabel(),
        role: client.role,
        type: "auth.ready",
        v: 1,
      }
      send(socket, ready)
      const initialSnapshot = (yield* promiseOperation(
        options.initialSnapshot
      )) as RelaySnapshot
      previousSnapshot = initialSnapshot
      const snapshot: RelayControlEvent = {
        event: "relay.snapshot",
        id: randomUUID(),
        payload: initialSnapshot,
        seq: ++eventSequence,
        type: "event",
        v: 1,
      }
      send(socket, snapshot)
      if (socket.readyState !== WebSocket.OPEN) return
      unsubscribeSnapshots = options.subscribeSnapshots((payload) => {
        const previous = previousSnapshot
        const next = payload as RelaySnapshot
        previousSnapshot = next
        if (!previous) return
        if (!snapshotDeltasEnabled) {
          const update: RelayControlEvent = {
            event: "relay.snapshot",
            id: randomUUID(),
            payload: next,
            seq: ++eventSequence,
            type: "event",
            v: 1,
          }
          send(socket, update)
          return
        }
        const delta = createRelaySnapshotDelta(previous, next, {
          nodeResources: nodeResourceDeltasEnabled,
        })
        if (!delta) return
        const update: RelayControlEvent = {
          event: "relay.snapshot.delta",
          id: randomUUID(),
          payload: delta,
          seq: ++eventSequence,
          type: "event",
          v: 1,
        }
        send(socket, update)
      })
    })
  }

  function requestClient(
    operation: RelayControlOperation,
    payload: unknown,
    timeoutMs: number,
    subject?: string
  ): Promise<unknown> {
    if (!authenticatedClient || socket.readyState !== WebSocket.OPEN) {
      return Effect.runPromise(
        controlFailure("Hearth control connection is unavailable")
      )
    }
    const duration = Math.min(
      Math.max(timeoutMs, 1),
      relayControlDeadlineMs(operation)
    )
    const id = randomUUID()
    const request: RelayControlRequest = {
      deadline: Date.now() + duration,
      id,
      operation,
      payload,
      ...(subject ? { subject } : {}),
      timeoutMs: duration,
      type: "request",
      v: 1,
    }
    return Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Deferred.make<unknown, Error>()
        reversePending.set(id, response)
        send(socket, request)
        const initial = yield* Deferred.await(response).pipe(
          Effect.timeoutOption(duration)
        )
        if (Option.isSome(initial)) return initial.value
        send(socket, {
          id: randomUUID(),
          replyTo: id,
          type: "cancel",
          v: 1,
        })
        return yield* Deferred.await(response).pipe(
          Effect.timeout(
            reverseRequestCancellationGraceMs(operation, duration)
          ),
          Effect.catchTag("TimeoutError", () =>
            controlFailure(
              `Hearth request timed out after ${duration}ms and did not confirm cancellation`
            )
          )
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reversePending.delete(id)
          })
        )
      )
    )
  }
}

function reverseRequestCancellationGraceMs(
  operation: RelayControlOperation,
  duration: number
): number {
  if (operation === "hearth.tailscale.instance.detach") {
    // A cancelled prepare may be inside one 60s peer RPC, then needs one
    // additional peer-RPC window to restore every node already changed.
    return Math.min(130_000, duration * 2 + 1_000)
  }
  return 1_000
}

function auditDetailsForRequest(
  request: RelayControlRequest,
  result: unknown
): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> = { operation: request.operation }
  const permission = actionForRequest(request)
  if (permission) {
    details.permission = permission
  }
  if (request.subject) {
    const cliSubject = parseCliSubject(request.subject)
    details.subject = cliSubject?.userId ?? request.subject
    if (cliSubject) {
      details.source = "cli"
      details.cliCredentialId = cliSubject.credentialId
    }
  }
  if (
    !request.payload ||
    typeof request.payload !== "object" ||
    Array.isArray(request.payload)
  ) {
    return details
  }
  const payload = Object.fromEntries(Object.entries(request.payload))
  if (typeof payload.instanceId === "string") {
    details.instanceId = payload.instanceId
  }
  if (typeof payload.databaseId === "string") {
    details.databaseId = payload.databaseId
  }
  if (typeof payload.appId === "string") {
    details.appId = payload.appId
  }
  if (request.operation === "app.create" && typeof payload.id === "string") {
    details.appId = payload.id
  }
  if (
    request.operation === "database.create" &&
    typeof payload.id === "string"
  ) {
    details.databaseId = payload.id
  }
  if (
    (request.operation === "instance.action" ||
      request.operation === "app.action") &&
    typeof payload.action === "string"
  ) {
    details.action = payload.action
  }
  if (
    request.operation === "instance.startup.write" &&
    payload.reinstall === true
  ) {
    details.reinstall = true
  }
  if (
    (request.operation === "instance.create" ||
      request.operation === "instance.provision.prepare") &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    const response = Object.fromEntries(Object.entries(result))
    if (typeof response.id === "string") {
      details.instanceId = response.id
    }
  }
  return details
}

function parseCliSubject(
  subject: string
): { credentialId: string; userId: string } | null {
  const match = /^cli\/([0-9a-f-]{36})\/([0-9A-Za-z_-]{1,64})$/u.exec(subject)
  return match?.[1] && match[2]
    ? { credentialId: match[1], userId: match[2] }
    : null
}

function closeClientSockets(
  authenticatedSockets: ReadonlyMap<WebSocket, RelayClientGrant>,
  clientId: string,
  reason: string
): void {
  for (const [socket, client] of authenticatedSockets) {
    if (client.id === clientId) socket.close(4403, reason)
  }
}

function authenticationVerifier(options: {
  readonly challenge: Omit<RelayAuthChallenge, "signature">
  readonly client: RelayClientGrant
  readonly signature: string
}): boolean {
  return Effect.runSync(
    Effect.try(() =>
      verify(
        null,
        Buffer.from(
          relayAuthResponseTranscript(options.challenge, options.client.id)
        ),
        createPublicKey(options.client.publicKey),
        Buffer.from(options.signature, "base64url")
      )
    ).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: (verified) => verified,
      })
    )
  )
}

function appFileAction(operation: RelayControlOperation): RelayAction {
  switch (operation) {
    case "instance.files.list":
    case "instance.files.directory.list":
    case "instance.files.directory.sizes":
    case "instance.files.search":
    case "instance.files.stat":
    case "instance.files.read":
    case "instance.files.database.read":
      return "app.files.read"
    default:
      return "app.files.write"
  }
}

function actionForRequest(request: RelayControlRequest): RelayAction | null {
  if (
    request.operation.startsWith("instance.files.") &&
    isRelayFileRoot(objectString(request.payload, "instanceId") ?? "")
  ) {
    const action = appFileAction(request.operation)
    return action === "app.files.read"
      ? "relay.files.read"
      : "relay.files.write"
  }
  // An app's data directory is served by the same file operations.
  if (
    request.operation.startsWith("instance.files.") &&
    appIdFromFileRoot(objectString(request.payload, "instanceId") ?? "")
  ) {
    return appFileAction(request.operation)
  }
  switch (request.operation) {
    case "relay.snapshot":
    case "relay.system.inspect":
    case "relay.update.status":
    case "relay.resources.read":
      return "relay.read"
    case "relay.update.apply":
      return "relay.update"
    // Updating already restarts the Relay.
    case "relay.restart":
      return "relay.update"
    case "relay.rename":
      return "relay.rename"
    case "relay.audit.list":
      return "relay.audit.read"
    case "relay.networking.read":
      return "instance.network.read"
    case "relay.networking.write":
      return "relay.configure"
    case "relay.tailscale.read":
    case "relay.tailscale.stack.list":
      return "instance.network.read"
    case "relay.tailscale.install":
    case "relay.tailscale.write":
      return "relay.configure"
    case "relay.tailscale.stack.apply":
      return "instance.create"
    case "relay.tailscale.stack.dns":
      return "instance.network.write"
    case "relay.tailscale.stack.remove":
      return "instance.delete"
    case "relay.terminal.attach":
    case "relay.terminal.heartbeat":
    case "relay.terminal.detach":
    case "relay.terminal.write":
    case "relay.terminal.claim":
    case "relay.terminal.restart":
      return "relay.terminal"
    // A root shell on the host could reboot it anyway.
    case "relay.host.restart":
      return "relay.terminal"
    case "relay.database.read":
      return "relay.database.read"
    case "relay.host.read":
    case "relay.proxy.read":
      return "relay.read"
    case "relay.host.files.mount":
      return "relay.files.mount"
    case "relay.proxy.config.read":
      return "instance.network.read"
    case "relay.proxy.write":
      return "relay.configure"
    case "relay.pairing.create":
      return "relay.pairing.create"
    case "relay.pairing.list":
      return "relay.pairing.list"
    case "relay.pairing.revoke":
      return "relay.pairing.revoke"
    case "relay.clients.list":
      return "relay.clients.list"
    case "relay.clients.update":
      return "relay.clients.update"
    case "relay.clients.revoke":
      return "relay.clients.revoke"
    case "browser.authorization.revise":
      return null
    case "brick.catalog":
    case "brick.recipe":
      return "brick.read"
    case "database.list":
    case "database.inspect":
      return "database.read"
    case "database.create":
      return "database.create"
    // Wiping deletes all of a database's data, so it takes deletion.
    case "database.delete":
    case "database.wipe":
      return "database.delete"
    case "database.action":
      return "database.power"
    case "database.credentials.rotate":
      return "database.credentials.rotate"
    case "database.network.write":
      return "database.network.write"
    case "database.dump.export":
      return "database.dump.export"
    case "database.dump.import":
      return "database.dump.import"
    // Reading or editing rows is reading or writing the data a dump carries.
    case "database.data.read":
      return "database.dump.export"
    case "database.data.write":
      return "database.dump.import"
    // A signed-in client can read and change everything a dump carries.
    case "database.terminal.attach":
    case "database.terminal.heartbeat":
    case "database.terminal.detach":
    case "database.terminal.write":
    case "database.terminal.claim":
    case "database.terminal.restart":
      return "database.dump.import"
    case "app.list":
    case "app.network.routes.read":
      return "app.read"
    case "app.create":
      return "app.create"
    case "app.delete":
      return "app.delete"
    case "app.deploy":
    case "app.action":
    case "app.network.write":
    case "app.network.routes.write":
      return "app.manage"
    case "app.terminal.attach":
    case "app.terminal.heartbeat":
    case "app.terminal.detach":
    case "app.terminal.write":
    case "app.terminal.claim":
    case "app.terminal.restart":
      return "app.terminal"
    case "backup.task.enqueue": {
      const kind = objectString(request.payload, "kind")
      if (kind === "create") return "backup.create"
      if (kind === "restore") return "backup.restore"
      if (kind === "delete") return "backup.delete"
      if (kind === "export") return "backup.download"
      return null
    }
    case "backup.task.cancel":
      return "backup.create"
    case "backup.task.get":
    case "backup.task.list":
      return "backup.read"
    case "schedule.apply":
    case "schedule.run":
    case "schedule.remove":
      return "schedule.write"
    case "schedule.overview":
      return "schedule.read"
    case "instance.create":
    case "instance.provision.prepare":
    case "instance.provision.claim":
    case "instance.startup.write":
      return "instance.create"
    case "instance.provision.cancel":
      return "instance.delete"
    case "instance.resources.read":
      return "instance.read"
    case "instance.rename":
      return "instance.rename"
    case "instance.delete":
      return "instance.delete"
    case "instance.action": {
      const action = objectString(request.payload, "action")
      if (action === "start") return "instance.power.start"
      if (action === "stop") return "instance.power.stop"
      if (action === "restart") return "instance.power.restart"
      if (action === "kill") return "instance.power.kill"
      return null
    }
    case "instance.files.list":
    case "instance.files.directory.list":
    case "instance.files.directory.sizes":
    case "instance.files.search":
      return "instance.files.list"
    case "instance.files.stat":
      return "instance.files.read"
    case "instance.files.read":
      return "instance.files.read"
    case "instance.files.write":
    case "instance.files.put":
      return "instance.files.write"
    case "instance.files.mutate":
    case "instance.files.mutate.result":
      return fileMutationAction(objectString(request.payload, "operation"))
    case "instance.files.upload-url":
      return "instance.files.upload-url"
    case "instance.files.database.read":
      return "instance.files.read"
    case "instance.files.database.write":
      return "instance.files.write"
    case "instance.console.history":
      return "instance.console.read"
    case "instance.console.write":
      return "instance.console.write"
    case "instance.console.complete":
      return "instance.console.read"
    case "instance.logs.share":
      return "instance.logs.share"
    case "instance.logs.latest":
      return "instance.logs.read"
    case "instance.network.ports.reserve":
    case "instance.network.ports.release":
    case "instance.network.ports.write":
      return "instance.network.write"
    case "instance.network.routes.read":
      return "instance.network.read"
    case "instance.network.databases.remove":
    case "instance.network.routes.write":
      return "instance.network.write"
    case "hearth.tailscale.instance.detach":
      return null
    case "sftp.authorization.resolve":
      return "instance.sftp.connect"
  }
  return null
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : null
}

function parseProtocols(value: string | undefined): ReadonlyArray<string> {
  return value?.split(",").map((protocol) => protocol.trim()) ?? []
}

const decodeControlClientMessage = (
  text: string
): Option.Option<typeof RelayControlClientMessageSchema.Type> =>
  Option.flatMap(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text),
    Schema.decodeUnknownOption(RelayControlClientMessageSchema)
  )

function promiseOperation<TResult>(
  run: () => Promise<TResult>
): EffectType.Effect<TResult, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("Relay control operation failed"),
  })
}

function controlFailure(message: string): EffectType.Effect<never, Error> {
  return Effect.fail(new Error(message))
}

function closeWebSocketServerEffect(
  server: WebSocketServer
): EffectType.Effect<void> {
  return Effect.callback<void>((resume) => {
    server.close(() => {
      resume(Effect.void)
    })
  })
}

function send(socket: WebSocket, message: unknown): void {
  sendSerialized(socket, JSON.stringify(message))
}

function sendSerialized(socket: WebSocket, serialized: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1013, "Control socket is not consuming messages")
    return
  }
  socket.send(serialized)
}

function sendError(
  socket: WebSocket,
  replyTo: string | null,
  code: string,
  message: string,
  retryable = false
): void {
  const error: RelayControlError = {
    code,
    id: randomUUID(),
    message,
    replyTo,
    retryable,
    type: "error",
    v: 1,
  }
  send(socket, error)
}

function relayControlErrorMessage(cause: unknown): string {
  if (!cause || typeof cause !== "object" || !("message" in cause)) {
    return "Relay operation failed"
  }
  const message = (cause as { message?: unknown }).message
  if (typeof message !== "string") return "Relay operation failed"
  const normalized = message.trim()
  if (normalized.length <= 240) return normalized
  const detail = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return detail && detail.length <= 240 ? detail : "Relay operation failed"
}

function relayControlErrorContext(
  request: Pick<RelayControlRequest, "id" | "operation">
) {
  return {
    operation: request.operation,
    attributes: {
      "kiln.request_id": request.id,
      "kiln.transport": "control-socket",
    },
  }
}
