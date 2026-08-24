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
import * as Sentry from "@sentry/node"

import {
  RelayControlClientMessageSchema,
  relayAuthenticationWindowMs,
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlDeadlineMs,
  relayControlMaxFrameBytes,
  relayControlRequestTimeoutMs,
  relayControlProtocol,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayAuthReady,
  RelayControlError,
  RelayControlEvent,
  RelayControlRequest,
  RelayControlResponse,
  RelayControlOperation,
} from "@workspace/contracts"

import { actionsForRole, isActionAllowed } from "./permissions.js"
import { relayBuildLabel } from "./build-info.js"
import { isSourceAllowed } from "./source-policy.js"
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
    const url = new URL(request.url ?? "/", "http://relay")
    if (url.pathname !== "/v1/socket") return
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
        authenticateClientEffect(message.clientId, message.signature).pipe(
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
    signature: string
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
      yield* completedAuthenticationEffect(client)
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
          if (!action || !isActionAllowed(actions, action)) {
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
            )
          )
          if (isAuditedOperation(request.operation)) {
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
                    Sentry.captureException(cause, {
                      tags: {
                        "kiln.operation": "relay.control.audit",
                      },
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
          if (!controller.signal.aborted) {
            Sentry.captureException(cause, {
              tags: relayControlFailureTags(request),
            })
          }
          sendError(
            socket,
            request.id,
            controller.signal.aborted
              ? "request_cancelled"
              : "operation_failed",
            controller.signal.aborted
              ? "Relay request was cancelled"
              : relayControlErrorMessage(cause)
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
    client: RelayClientGrant
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
      authenticatedClient = client
      yield* Fiber.interrupt(authenticationTimeoutFiber)
      sessions.set(challenge.sessionId, client)
      socketSessions.set(socket, challenge.sessionId)
      authenticatedSockets.set(socket, client)
      reverseRequesters.set(socket, requestClient)
      yield* promiseOperation(() =>
        options.runEffect(
          options.state.touchClient(client.id, Date.now(), peerAddress ?? null)
        )
      )
      const ready: RelayAuthReady = {
        actions: actionsForRole(client.role, client.actions),
        clientId: client.id,
        protocol: relayControlProtocol,
        relayBuild: relayBuildLabel(),
        role: client.role,
        type: "auth.ready",
        v: 1,
      }
      send(socket, ready)
      const snapshot: RelayControlEvent = {
        event: "relay.snapshot",
        id: randomUUID(),
        payload: yield* promiseOperation(options.initialSnapshot),
        seq: ++eventSequence,
        type: "event",
        v: 1,
      }
      send(socket, snapshot)
      if (socket.readyState !== WebSocket.OPEN) return
      unsubscribeSnapshots = options.subscribeSnapshots((payload) => {
        const update: RelayControlEvent = {
          event: "relay.snapshot",
          id: randomUUID(),
          payload,
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

export function isAuditedOperation(operation: RelayControlOperation): boolean {
  return (
    operation === "relay.rename" ||
    operation === "relay.update.apply" ||
    operation === "relay.pairing.create" ||
    operation === "relay.pairing.revoke" ||
    operation === "relay.clients.update" ||
    operation === "relay.clients.revoke" ||
    operation === "relay.networking.write" ||
    operation === "relay.tailscale.install" ||
    operation === "relay.tailscale.stack.apply" ||
    operation === "relay.tailscale.stack.dns" ||
    operation === "relay.tailscale.stack.remove" ||
    operation === "relay.tailscale.write" ||
    operation === "relay.proxy.write" ||
    operation === "instance.create" ||
    operation === "instance.provision.prepare" ||
    operation === "instance.provision.claim" ||
    operation === "instance.provision.cancel" ||
    operation === "instance.startup.write" ||
    operation === "instance.rename" ||
    operation === "instance.delete" ||
    operation === "instance.action" ||
    operation === "instance.files.write" ||
    operation === "instance.files.upload-url" ||
    operation === "instance.files.mutate" ||
    operation === "instance.console.write" ||
    operation === "instance.network.ports.write" ||
    operation === "instance.network.routes.write" ||
    operation === "database.create" ||
    operation === "database.delete" ||
    operation === "database.action" ||
    operation === "database.credentials.rotate" ||
    operation === "database.network.write" ||
    operation === "database.dump.export" ||
    operation === "database.dump.import" ||
    operation === "backup.task.enqueue" ||
    operation === "backup.task.cancel" ||
    operation === "schedule.apply" ||
    operation === "schedule.run" ||
    operation === "schedule.remove"
  )
}

export function auditDetailsForRequest(
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
  if (
    request.operation === "database.create" &&
    typeof payload.id === "string"
  ) {
    details.databaseId = payload.id
  }
  if (
    request.operation === "instance.action" &&
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

export function authenticationVerifier(options: {
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

function actionForRequest(request: RelayControlRequest): RelayAction | null {
  switch (request.operation) {
    case "relay.snapshot":
    case "relay.system.inspect":
    case "relay.update.status":
      return "relay.read"
    case "relay.update.apply":
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
    case "relay.proxy.read":
      return "relay.read"
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
    case "brick.catalog":
    case "brick.recipe":
      return "brick.read"
    case "database.list":
      return "database.read"
    case "database.create":
      return "database.create"
    case "database.delete":
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
    case "instance.files.search":
      return "instance.files.list"
    case "instance.files.stat":
      return "instance.files.read"
    case "instance.files.read":
      return "instance.files.read"
    case "instance.files.write":
    case "instance.files.mutate":
    case "instance.files.mutate.result":
      return "instance.files.write"
    case "instance.files.upload-url":
      return "instance.files.upload-url"
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
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
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

export function relayControlErrorMessage(cause: unknown): string {
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

export function relayControlFailureTags(
  request: Pick<RelayControlRequest, "id" | "operation">
) {
  return {
    "kiln.operation": request.operation,
    "kiln.request_id": request.id,
    "kiln.transport": "control-socket",
  }
}
