import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect"
import type { Effect as EffectType } from "effect"
import { WebSocket, WebSocketServer } from "ws"

import {
  RelayControlClientMessageSchema,
  relayAuthenticationWindowMs,
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayHearthContainerTranscript,
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
  relayLinkedBackupsV1Feature,
  relayPeerTransfersV1Feature,
  relayRestartV1Feature,
  relayResourcesV1Feature,
  relayFilePutV1Feature,
  relayResourceLimitsV1Feature,
  relayDatabaseLimitsV1Feature,
  relayAppLimitsV1Feature,
  relayAppGitHubV1Feature,
  relayAppImageUpdatesV1Feature,
  relaySecurityInventoryV1Feature,
  relayPlatformV1Feature,
  relayPlatformV2Feature,
  relayPlatformDatabaseV1Feature,
  relayDatabaseDumpFilesV1Feature,
  relayInstallationV1Feature,
  relayVolumesV1Feature,
  relayDatabaseProvisioningV1Feature,
  relayAppProvisioningV1Feature,
  appIdFromFileRoot,
  isRelayFileRoot,
  relayFileRequestReplayV1Feature,
  relaySnapshotDeltaFeature,
  relaySnapshotNodeResourcesFeature,
  isAuditedRelayControlOperation,
  relayControlOperationChanges,
  relayControlOperationRefusedWhilePaused,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayAuthReady,
  RelayControlError,
  RelayControlEvent,
  RelayControlRequest,
  RelayControlResponse,
  RelayControlOperation,
  RelayOperationLookup,
  RelaySnapshot,
} from "@workspace/contracts"

import { RelayNotFoundError } from "./effect/errors.js"
import { promiseEffect } from "./effect/promise.js"
import {
  reportRelayError,
  traceParentSpan,
  traceRelayEffect,
  traceRelayPromise,
} from "./effect/runtime.js"
import {
  actionsForRole,
  fileMutationAction,
  fileTransferAction,
  isActionAllowed,
} from "./permissions.js"
import { relayBuildLabel } from "./build-info.js"
import { isSourceAllowed } from "./source-policy.js"
import { createRelaySnapshotDelta } from "./snapshot-delta.js"
import { requestUrl } from "./request-url.js"
import type { RelayAction } from "./permissions.js"
import {
  LaneRejectedError,
  type LaneLock,
  type LaneTicket,
  type OperationLanes,
} from "./operation-lanes.js"
import type { RelayIdentity } from "./effect/identity.js"
import { countRelayRefusal, type ControlCapacity } from "./relay-capacity.js"
import { InstallationReplaceError } from "./installation.js"
import type {
  RelayClientGrant,
  RelayOperationRecord,
  RelayStateStore,
} from "./effect/state.js"
import type { Server } from "node:http"

const HEARTBEAT_INTERVAL_MS = 15_000
// Slow-consumer bound. Allows one full-size control frame to be in flight so
// a large (but accepted) response does not look like a stuck peer.
const MAX_BUFFERED_BYTES = 2 * relayControlMaxFrameBytes
const MAX_IN_FLIGHT_REQUESTS = 32
const MAX_CONTROL_SESSIONS = 128
const MAX_CONTROL_SESSIONS_PER_CLIENT = 4

export interface HearthContainerClaim {
  readonly containerId: string
  readonly installationId: string
  readonly proof: string
  readonly transcript: string
}

export interface ControlSocketOptions {
  // Saves the installation ID a full-access Hearth authenticated with. The
  // session is ready only once this settles; it reports its own failures.
  readonly adoptInstallationId?: (installationId: string) => Promise<void>
  /**
   * Checks, in the background, the container a full-access Hearth says it
   * runs in: `proof` must be an HMAC of `transcript` keyed by that
   * container's BETTER_AUTH_SECRETS.
   */
  readonly identifyHearth?: (claim: HearthContainerClaim) => void
  /**
   * Runs once an authorized request has its place in line, before it waits
   * for its locks: a delete stops a running deployment here, so it doesn't
   * wait for the build it is about to remove.
   */
  readonly beforeRun?: (request: RelayControlRequest) => void
  readonly execute: (
    request: RelayControlRequest,
    client: RelayClientGrant,
    signal: AbortSignal,
    requestHearth: (
      operation: RelayControlOperation,
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>,
    /** What the connected Hearth announced it understands. */
    hearthFeatures: ReadonlySet<string>
  ) => Promise<unknown>
  readonly identity: RelayIdentity
  readonly initialSnapshot: () => Promise<unknown>
  /** The lanes every Relay mutation waits in. */
  readonly lanes: OperationLanes
  /**
   * The locks a request holds while it runs, or null for one that needs
   * none. Requests take their place in line as they arrive.
   */
  readonly requestLocks: (
    request: RelayControlRequest
  ) => ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>> | null
  readonly subscribeSnapshots: (
    listener: (snapshot: unknown) => void
  ) => () => void
  readonly runEffect: <T, E>(effect: EffectType.Effect<T, E>) => Promise<T>
  readonly server: Server
  readonly state: RelayStateStore["Service"]
}

export interface ControlSocketServer {
  /** How full the control sessions are, across every Hearth session. */
  readonly capacity: () => ControlCapacity
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
  // Changes under an operation ID, by client and ID, so a lookup or a
  // repeated request from any of the client's sessions sees them.
  const operations: OperationRegistry = {
    finished: new Map(),
    running: new Map(),
    writes: new Set(),
  }
  const capacity: CapacityTracking = {
    orphanedWork: new Set(),
    sessions: new Set(),
  }
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
      operations,
      capacity,
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
    capacity: () => {
      const now = Date.now()
      let inFlight = 0
      let reversePending = 0
      let oldestReceivedAt = now
      for (const session of capacity.sessions) {
        inFlight += session.inFlight.size
        reversePending += session.reversePending.size
        for (const request of session.inFlight.values()) {
          oldestReceivedAt = Math.min(oldestReceivedAt, request.receivedAt)
        }
      }
      let oldestWorkStartedAt = now
      for (const work of capacity.orphanedWork) {
        oldestWorkStartedAt = Math.min(oldestWorkStartedAt, work.startedAt)
      }
      return {
        inFlight,
        oldestInFlightMs: now - oldestReceivedAt,
        orphanedWork: capacity.orphanedWork.size,
        oldestOrphanedWorkMs: now - oldestWorkStartedAt,
        reversePending,
      }
    },
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
          // Changes that already answered keep their journal outcome.
          yield* Effect.forEach([...operations.writes], Fiber.await, {
            discard: true,
          }).pipe(Effect.timeoutOption(OUTCOME_WRITE_DRAIN))
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

interface InFlightRequest {
  readonly controller: AbortController
  fiber: Fiber.Fiber<void, unknown> | null
  readonly receivedAt: number
  readonly ticket: LaneTicket | null
  /** The request's work while it runs, so it's seen if it outlives it. */
  work: RunningWork | null
}

interface RunningWork {
  readonly startedAt: number
}

// What every session is running, read for the Relay's capacity metrics.
interface CapacityTracking {
  readonly orphanedWork: Set<RunningWork>
  readonly sessions: Set<{
    readonly inFlight: ReadonlyMap<string, InFlightRequest>
    readonly reversePending: ReadonlyMap<string, unknown>
  }>
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
  operations: OperationRegistry,
  capacity: CapacityTracking,
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
  let hearthFeatures: ReadonlySet<string> = new Set()
  let nodeResourceDeltasEnabled = false
  const inFlight = new Map<string, InFlightRequest>()
  const reversePending = new Map<string, Deferred.Deferred<unknown, Error>>()
  const tracked = { inFlight, reversePending }
  capacity.sessions.add(tracked)
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
          message.installationId,
          message.hearthContainer
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
      request?.ticket?.cancel()
      request?.controller.abort()
      // A change withdrawn from its lane answers that it was cancelled, and
      // one already running answers with how it went, so Hearth learns
      // which. Requests outside the lanes stop here.
      if (!request?.ticket) request?.fiber?.interruptUnsafe()
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
      Effect.runFork(
        countRelayRefusal(options.identity.fingerprint, "in_flight_limit")
      )
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
    const client = authenticatedClient
    const receivedAt = Date.now()
    const controller = new AbortController()
    // Take the request's place in line before any asynchronous work, so
    // requests that conflict run in the order they arrived.
    const planned = Result.try(() => options.requestLocks(message))
    if (Result.isFailure(planned)) {
      reportRelayError(planned.failure, relayControlErrorContext(message))
      sendError(
        socket,
        message.id,
        "invalid_message",
        "Invalid control request"
      )
      return
    }
    const locks = planned.success
    const ticket =
      locks === null
        ? null
        : options.lanes.admit({ label: message.operation, locks })
    const request: InFlightRequest = {
      controller,
      fiber: null,
      receivedAt,
      ticket,
      work: null,
    }
    const onWork = (running: Promise<unknown>) => {
      const work = { startedAt: Date.now() }
      request.work = work
      // A change can start after its session closed; nothing waits for it.
      if (inFlight.get(message.id) !== request) capacity.orphanedWork.add(work)
      const settled = () => {
        if (request.work === work) request.work = null
        capacity.orphanedWork.delete(work)
      }
      Effect.runFork(
        promiseEffect(() => running).pipe(
          Effect.ensuring(Effect.sync(settled)),
          Effect.ignore
        )
      )
    }
    controller.signal.addEventListener("abort", () => ticket?.cancel(), {
      once: true,
    })
    inFlight.set(message.id, request)
    // The request keeps its slot until this fiber ends, however it ends. A
    // cancel read in the same batch of frames interrupts it at the yield,
    // before the request itself has started.
    request.fiber = Effect.runFork(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            executeRequestEffect(
              message,
              client,
              controller,
              ticket,
              receivedAt,
              onWork
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (inFlight.get(message.id) === request) {
              inFlight.delete(message.id)
            }
            // Work its request no longer waits for keeps running; it's
            // counted until it settles.
            if (request.work) capacity.orphanedWork.add(request.work)
            // A request refused before it ran gives up its place in line.
            ticket?.cancel()
          })
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
    // Requests still waiting are withdrawn, so none runs after Hearth has
    // gone. Ones already running finish and keep their locks until they do.
    for (const request of inFlight.values()) {
      request.ticket?.cancel()
      request.controller.abort()
      request.fiber?.interruptUnsafe()
      // A change can't be interrupted, so its request may only finish once
      // its work does; until then the work is orphaned.
      if (request.work) capacity.orphanedWork.add(request.work)
    }
    inFlight.clear()
    capacity.sessions.delete(tracked)
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
    installationId: string | undefined,
    hearthContainer: { readonly id: string; readonly proof: string } | undefined
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
      hearthFeatures = new Set(features)
      snapshotDeltasEnabled = features.includes(relaySnapshotDeltaFeature)
      nodeResourceDeltasEnabled = features.includes(
        relaySnapshotNodeResourcesFeature
      )
      yield* completedAuthenticationEffect(
        client,
        installationId,
        hearthContainer
      )
    })
  }

  function executeRequestEffect(
    request: RelayControlRequest,
    sessionClient: RelayClientGrant,
    controller: AbortController,
    ticket: LaneTicket | null,
    receivedAt: number,
    onWork: (running: Promise<unknown>) => void
  ): EffectType.Effect<void> {
    const duration = relayControlRequestTimeoutMs(request, receivedAt)
    if (duration === null) {
      return Effect.sync(() => {
        sendError(
          socket,
          request.id,
          "invalid_timeout",
          "Request timeout is invalid"
        )
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
          if (request.operation === "operation.get") {
            const lookup = yield* lookupOperation(
              currentClient.id,
              objectString(request.payload, "operationId") ?? ""
            )
            yield* Effect.sync(() => sendResponse(request, lookup))
            return
          }
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
          const execution = promiseOperation(() => {
            const running = traceRelayPromise(
              "relay.control.execute",
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
                    ),
                  hearthFeatures
                ),
              { "relay.operation": request.operation }
            )
            onWork(running)
            return running
          })
          if (
            options.lanes.paused &&
            relayControlOperationRefusedWhilePaused(request.operation)
          ) {
            ticket?.cancel()
            yield* Effect.sync(() =>
              sendError(
                socket,
                request.id,
                "relay_paused",
                "This Relay is paused",
                false
              )
            )
            return
          }
          const operationId = relayControlOperationChanges(request.operation)
            ? request.operationId
            : undefined
          if (operationId === undefined) options.beforeRun?.(request)
          const { payload, ran } =
            operationId === undefined
              ? {
                  payload: yield* runInLane(ticket, execution),
                  ran: true,
                }
              : yield* journaled(
                  currentClient.id,
                  operationId,
                  request,
                  ticket,
                  execution
                )
          if (ran && isAuditedRelayControlOperation(request.operation)) {
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
          yield* Effect.sync(() => sendResponse(request, payload))
        }),
      (timeoutFiber) => Fiber.interrupt(timeoutFiber)
    )
    // The whole request, from its client check through its journal, its turn
    // in the lanes, and its reply, joins the trace of the Hearth that sent it.
    const traced = traceRelayEffect(
      "relay.control.request",
      operation,
      {
        "relay.operation": request.operation,
        ...(request.operationId
          ? { "relay.operation_id": request.operationId }
          : {}),
      },
      traceParentSpan(request.traceparent)
    )
    return traced.pipe(
      Effect.catch((cause) =>
        Effect.suspend(() => {
          const failure = controlFailureFor(
            request,
            cause,
            controller.signal.aborted
          )
          sendError(
            socket,
            request.id,
            failure.code,
            failure.message,
            failure.retryable
          )
          // Too many changes were already waiting in the lanes.
          return failure.code === "too_many_requests"
            ? countRelayRefusal(options.identity.fingerprint, "lanes_full")
            : Effect.void
        })
      )
    )
  }

  function sendResponse(request: RelayControlRequest, payload: unknown) {
    const response: RelayControlResponse = {
      id: randomUUID(),
      payload,
      replyTo: request.id,
      type: "response",
      v: 1,
    }
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
  }

  function lookupOperation(
    clientId: string,
    operationId: string
  ): EffectType.Effect<RelayOperationLookup, Error> {
    const key = operationKey(clientId, operationId)
    if (operations.running.has(key)) {
      return Effect.succeed({ status: "running" })
    }
    const recent = recentOperation(operations, key)
    if (recent) return Effect.succeed(lookupFor(recent.outcome))
    return promiseOperation(() =>
      options.runEffect(options.state.getOperation(clientId, operationId))
    ).pipe(
      Effect.map((record): RelayOperationLookup =>
        record ? lookupFor(recordedOutcome(record)) : { status: "unknown" }
      )
    )
  }

  /**
   * Runs a change under its operation ID. It's claimed at once, so a repeat
   * from any session waits for it; and recorded as accepted before anything
   * it does, including `beforeRun`. Its outcome is kept in memory as soon as
   * it finishes, and written to the journal without holding up the reply. A
   * repeat of a change this Relay already took gets that change's answer
   * instead, and `ran: false`.
   */
  function journaled(
    clientId: string,
    operationId: string,
    request: RelayControlRequest,
    ticket: LaneTicket | null,
    execution: EffectType.Effect<unknown, unknown>
  ): EffectType.Effect<{ payload: unknown; ran: boolean }, unknown> {
    const key = operationKey(clientId, operationId)
    const digest = payloadDigest(request)
    const repeat = (earlier: SettledOperation) =>
      Effect.gen(function* () {
        ticket?.cancel()
        const settled =
          earlier.digest === digest ? earlier.outcome : conflictingOutcome
        return { payload: yield* settleRecorded(settled), ran: false }
      })
    const live = operations.running.get(key)
    if (live) {
      // A repeat gives up its place in line before waiting: the change may
      // be waiting behind it.
      ticket?.cancel()
      // Until the journal is read, the request that claimed the ID may not
      // be the one that made the change under it.
      return live.digest !== null && live.digest !== digest
        ? repeat({ digest: live.digest, outcome: conflictingOutcome })
        : Deferred.await(live.settled).pipe(Effect.flatMap(repeat))
    }
    const recent = recentOperation(operations, key)
    if (recent) return repeat(recent)

    const claim: LiveOperation = {
      digest: null,
      settled: Deferred.makeUnsafe<SettledOperation>(),
    }
    operations.running.set(key, claim)
    let settled = false
    // Remembers how the change under this ID went, as the request that made
    // it sent it (`madeWith`).
    const settle = (outcome: RecordedOutcome, madeWith = digest) =>
      Effect.sync(() => {
        if (settled) return
        settled = true
        operations.running.delete(key)
        rememberOperation(operations, key, madeWith, outcome)
        Deferred.doneUnsafe(
          claim.settled,
          Exit.succeed({ digest: madeWith, outcome })
        )
      })
    const run = Effect.gen(function* () {
      const prior = yield* promiseOperation(() =>
        options.runEffect(options.state.getOperation(clientId, operationId))
      )
      if (prior) {
        // Taken before this Relay last restarted, or before its memory of
        // it lapsed.
        ticket?.cancel()
        // The change made under this ID keeps its own outcome; a request
        // reusing the ID for something else only learns of the conflict.
        const outcome = recordedOutcome(prior)
        yield* settle(outcome, prior.payloadSha256)
        return {
          payload: yield* settleRecorded(
            prior.payloadSha256 === digest ? outcome : conflictingOutcome
          ),
          ran: false,
        }
      }
      claim.digest = digest
      yield* promiseOperation(() =>
        options.runEffect(
          options.state.startOperation({
            clientId,
            operation: request.operation,
            operationId,
            payloadSha256: digest,
            startedAt: Date.now(),
          })
        )
      )
      options.beforeRun?.(request)
      const exit = yield* Effect.exit(runInLane(ticket, execution))
      const outcome: RecordedOutcome = Exit.isSuccess(exit)
        ? { kept: true, payload: exit.value, status: "succeeded" }
        : {
            ...controlFailureFor(request, Cause.squash(exit.cause), false),
            status: "failed",
          }
      yield* settle(outcome)
      // Lookups find the outcome in memory first, so the reply doesn't wait
      // for the journal. Closing the socket waits for the write.
      const write = yield* Effect.forkDetach(
        recordOutcome(clientId, operationId, outcome)
      )
      operations.writes.add(write)
      write.addObserver(() => {
        operations.writes.delete(write)
      })
      return { payload: yield* exit, ran: true }
    })
    // Once claimed, it always settles, even if Hearth stops waiting: nothing
    // may wait on it forever.
    return Effect.uninterruptible(
      run.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : settle({
                ...controlFailureFor(request, Cause.squash(exit.cause), false),
                status: "failed",
              })
        )
      )
    )
  }

  // Records how a change went. It already ran, so a failed write is retried,
  // in the background once the first attempts fail, and never raised; the
  // outcome stays in memory for lookups meanwhile.
  function recordOutcome(
    clientId: string,
    operationId: string,
    outcome: RecordedOutcome
  ): EffectType.Effect<void> {
    // Only the outcome, never the reply, so retries hold nothing large.
    const finished = {
      clientId,
      errorCode: outcome.status === "failed" ? outcome.code : null,
      errorMessage: outcome.status === "failed" ? outcome.message : null,
      finishedAt: Date.now(),
      operationId,
      retryable: outcome.status === "failed" && outcome.retryable,
      status:
        outcome.status === "succeeded"
          ? ("succeeded" as const)
          : ("failed" as const),
    }
    const write = promiseOperation(() =>
      options.runEffect(options.state.finishOperation(finished))
    )
    return write.pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
      Effect.catch((cause) =>
        Effect.sync(() => {
          reportRelayError(cause, {
            operation: "relay.control.operation.record",
          })
        }).pipe(
          Effect.andThen(
            write.pipe(
              Effect.retry({
                schedule: Schedule.spaced("30 seconds"),
                times: 120,
              }),
              Effect.ignore,
              Effect.forkDetach
            )
          ),
          Effect.asVoid
        )
      )
    )
  }

  function completedAuthenticationEffect(
    client: RelayClientGrant,
    installationId: string | undefined,
    hearthContainer: { readonly id: string; readonly proof: string } | undefined
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
      if (
        options.identifyHearth &&
        hearthContainer &&
        installationId &&
        client.role === "full_access"
      ) {
        options.identifyHearth({
          containerId: hearthContainer.id,
          installationId,
          proof: hearthContainer.proof,
          transcript: relayHearthContainerTranscript(
            unsignedChallenge,
            client.id,
            hearthContainer.id
          ),
        })
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
          relayResourceLimitsV1Feature,
          relayDatabaseLimitsV1Feature,
          relayAppLimitsV1Feature,
          relayDatabaseProvisioningV1Feature,
          relayAppProvisioningV1Feature,
          relayAppGitHubV1Feature,
          relayVolumesV1Feature,
          relayAppImageUpdatesV1Feature,
          relayPlatformV1Feature,
          relayPlatformV2Feature,
          relayPlatformDatabaseV1Feature,
          relayDatabaseDumpFilesV1Feature,
          relayInstallationV1Feature,
          relaySecurityInventoryV1Feature,
          relayPeerTransfersV1Feature,
          relayLinkedBackupsV1Feature,
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

// Runs a request in its lane; the lane notes on the request's span how long
// it waited for its turn.
function runInLane<A, E>(
  ticket: LaneTicket | null,
  execution: EffectType.Effect<A, E>
): EffectType.Effect<A, E | LaneRejectedError> {
  return ticket ? ticket.run(execution) : execution
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
  if (
    (request.operation === "app.create" ||
      request.operation === "app.provision.prepare") &&
    typeof payload.id === "string"
  ) {
    details.appId = payload.id
  }
  if (
    (request.operation === "database.create" ||
      request.operation === "database.provision.prepare") &&
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
    // Holding the Relay paused freezes it for every Hearth.
    case "relay.pause.write":
      return "relay.configure"
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
    // A shell in Kiln's own containers is as much as a host shell.
    case "relay.platform.terminal.attach":
    case "relay.platform.terminal.heartbeat":
    case "relay.platform.terminal.detach":
    case "relay.platform.terminal.write":
    case "relay.platform.terminal.claim":
    case "relay.platform.terminal.restart":
      return "relay.terminal"
    // A root shell on the host could reboot it anyway.
    case "relay.host.restart":
      return "relay.terminal"
    case "relay.database.read":
      return "relay.database.read"
    case "relay.host.read":
    case "relay.proxy.read":
    case "relay.security.targets":
    case "relay.security.inventory":
      return "relay.read"
    case "relay.host.files.mount":
      return "relay.files.mount"
    case "relay.proxy.config.read":
      return "instance.network.read"
    case "relay.proxy.write":
      return "relay.configure"
    case "relay.volumes.read":
      return "relay.read"
    case "relay.volumes.create":
    case "relay.volumes.rename":
    case "relay.volumes.delete":
      return "relay.configure"
    case "relay.pairing.create":
      return "relay.pairing.create"
    case "relay.pairing.list":
      return "relay.pairing.list"
    case "relay.pairing.revoke":
      return "relay.pairing.revoke"
    case "relay.clients.list":
      return "relay.clients.list"
    // Hearth's logs can hold anything it printed. Only the Hearth this
    // Relay installed may restart or repair it; the Relay checks that too.
    case "relay.platform.read":
      return "relay.read"
    case "relay.platform.logs":
      return "relay.logs.read"
    case "relay.platform.action":
      return "relay.update"
    // Hearth's own database holds everything Hearth knows.
    case "relay.platform.database.read":
    case "relay.platform.database.write":
      return "relay.update"
    // Only full access, which the handler checks too.
    case "relay.installation.read":
    case "relay.installation.replace":
      return "relay.update"
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
    // Limits are part of what a database is created with, as a game
    // server's startup settings are.
    case "database.create":
    case "database.provision.prepare":
    case "database.provision.claim":
    case "database.limits.write":
      return "database.create"
    // Wiping deletes all of a database's data, so it takes deletion.
    case "database.provision.cancel":
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
    case "app.image.check":
      return "app.read"
    case "app.deployment.read":
      return "app.logs.read"
    case "app.create":
    case "app.provision.prepare":
    case "app.provision.claim":
      return "app.create"
    case "app.provision.cancel":
    case "app.delete":
      return "app.delete"
    case "app.deploy":
    case "app.action":
    case "app.limits.write":
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
    // Copying files between Relays is downloading them from the source and
    // uploading them to the destination.
    case "transfer.source.prepare":
    case "transfer.source.get":
    case "transfer.source.discard":
      return fileTransferAction(
        objectString(request.payload, "rootId") ?? "",
        "download"
      )
    case "transfer.pull.start":
      return fileTransferAction(
        objectString(objectRecord(request.payload, "target") ?? {}, "rootId") ??
          "",
        "upload"
      )
    case "transfer.pull.get":
    case "transfer.pull.cancel":
      return fileTransferAction(
        objectString(request.payload, "rootId") ?? "",
        "upload"
      )
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

function objectRecord(value: unknown, key: string): object | null {
  if (!value || typeof value !== "object" || !(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return field && typeof field === "object" ? field : null
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

/** How a change run under an operation ID went, as later lookups see it. */
type RecordedOutcome =
  | {
      /** False once the reply itself is no longer kept. */
      readonly kept: boolean
      readonly payload: unknown
      readonly status: "succeeded"
    }
  | {
      readonly code: string
      readonly message: string
      readonly retryable: boolean
      readonly status: "failed"
    }
  | { readonly status: "interrupted" }

/** A recorded failure, answered with its own code. */
class RecordedFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

const conflictingOutcome: RecordedOutcome = {
  code: "operation_conflict",
  message: "A different request already used this operation ID",
  retryable: false,
  status: "failed",
}

function operationKey(clientId: string, operationId: string): string {
  return `${clientId}\u0000${operationId}`
}

function payloadDigest(request: RelayControlRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.operation, request.payload ?? null]))
    .digest("hex")
}

/** How a change under an ID went, and the request that made it (`digest`). */
interface SettledOperation {
  readonly digest: string
  readonly outcome: RecordedOutcome
}

interface LiveOperation {
  /** The request making the change, once the journal shows it's this one. */
  digest: string | null
  readonly settled: Deferred.Deferred<SettledOperation>
}

interface FinishedOperation extends SettledOperation {
  readonly expiresAt: number
}

interface OperationRegistry {
  /** Recently finished changes, with their replies, held only in memory. */
  readonly finished: Map<string, FinishedOperation>
  readonly running: Map<string, LiveOperation>
  /** Journal writes of finished changes' outcomes still under way. */
  readonly writes: Set<Fiber.Fiber<void, unknown>>
}

// How long closing waits for outcome writes; each normally takes well under
// a millisecond, and its first retries last about three seconds.
const OUTCOME_WRITE_DRAIN = "5 seconds"

// Long enough for Hearth to look up any change whose reply it lost: past the
// longest change deadline.
const RECENT_OPERATION_MS = 20 * 60_000
const MAX_RECENT_OPERATIONS = 500
// Larger replies are dropped from memory; lookups report the outcome alone.
const MAX_RECENT_RESULT_BYTES = 64 * 1024

function rememberOperation(
  operations: OperationRegistry,
  key: string,
  digest: string,
  outcome: RecordedOutcome
) {
  const now = Date.now()
  for (const [oldest, entry] of operations.finished) {
    if (
      entry.expiresAt > now &&
      operations.finished.size < MAX_RECENT_OPERATIONS
    ) {
      break
    }
    operations.finished.delete(oldest)
  }
  const kept =
    outcome.status !== "succeeded" ||
    Buffer.byteLength(JSON.stringify(outcome.payload) ?? "") <=
      MAX_RECENT_RESULT_BYTES
  operations.finished.set(key, {
    digest,
    expiresAt: now + RECENT_OPERATION_MS,
    outcome: kept
      ? outcome
      : { kept: false, payload: null, status: "succeeded" },
  })
}

function recentOperation(
  operations: OperationRegistry,
  key: string
): FinishedOperation | null {
  const entry = operations.finished.get(key)
  if (!entry) return null
  if (entry.expiresAt > Date.now()) return entry
  operations.finished.delete(key)
  return null
}

function lookupFor(outcome: RecordedOutcome): RelayOperationLookup {
  if (outcome.status === "succeeded") {
    return outcome.kept
      ? { result: outcome.payload, status: "succeeded" }
      : { status: "succeeded" }
  }
  if (outcome.status === "interrupted") return { status: "interrupted" }
  return {
    code: outcome.code,
    message: outcome.message,
    retryable: outcome.retryable,
    status: "failed",
  }
}

// What the journal says of a change. It keeps outcomes, never replies,
// which can carry secrets such as pairing tokens.
function recordedOutcome(record: RelayOperationRecord): RecordedOutcome {
  if (record.status === "succeeded") {
    return { kept: false, payload: null, status: "succeeded" }
  }
  if (record.status === "failed") {
    return {
      code: record.errorCode ?? "operation_failed",
      message: record.errorMessage ?? "Relay operation failed",
      retryable: record.retryable,
      status: "failed",
    }
  }
  // Running in the journal but not in this process: a restart cut it off.
  return { status: "interrupted" }
}

// The reply for a change that ran before, or is running, under the same ID.
function settleRecorded(
  earlier: Deferred.Deferred<RecordedOutcome> | RecordedOutcome
): EffectType.Effect<unknown, RecordedFailure> {
  const outcome: EffectType.Effect<RecordedOutcome> = Deferred.isDeferred(
    earlier
  )
    ? Deferred.await(earlier as Deferred.Deferred<RecordedOutcome>)
    : Effect.succeed(earlier as RecordedOutcome)
  return outcome.pipe(
    Effect.flatMap((outcome) =>
      outcome.status === "succeeded"
        ? outcome.kept
          ? Effect.succeed(outcome.payload)
          : Effect.fail(
              new RecordedFailure(
                "result_unavailable",
                "The change went through, but the Relay no longer has its reply. Refresh to see the result.",
                false
              )
            )
        : Effect.fail(
            outcome.status === "failed"
              ? new RecordedFailure(
                  outcome.code,
                  outcome.message,
                  outcome.retryable
                )
              : new RecordedFailure(
                  "operation_interrupted",
                  "The Relay restarted while this change ran; check whether it took effect",
                  false
                )
          )
    )
  )
}

// The error code, message, and retryability a failed request answers with.
function controlFailureFor(
  request: RelayControlRequest,
  cause: unknown,
  aborted: boolean
): {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
} {
  if (cause instanceof RecordedFailure) {
    return {
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
    }
  }
  if (cause instanceof LaneRejectedError && cause.reason === "paused") {
    return { code: "relay_paused", message: cause.message, retryable: false }
  }
  // Withdrawn from its lane before it ran, as when Hearth disconnected.
  if (cause instanceof LaneRejectedError && cause.reason === "cancelled") {
    return {
      code: "operation_withdrawn",
      message: "The change was withdrawn before it ran",
      retryable: true,
    }
  }
  if (aborted) {
    return {
      code: "request_cancelled",
      message: "Relay request was cancelled",
      retryable: false,
    }
  }
  if (cause instanceof RelayNotFoundError) {
    return { code: "not_found", message: cause.message, retryable: false }
  }
  if (cause instanceof InstallationReplaceError) {
    return { code: cause.code, message: cause.message, retryable: false }
  }
  if (cause instanceof LaneRejectedError && cause.reason === "busy") {
    return {
      code: "too_many_requests",
      message: cause.message,
      retryable: true,
    }
  }
  reportRelayError(cause, relayControlErrorContext(request))
  return {
    code: "operation_failed",
    message: relayControlErrorMessage(cause),
    retryable: false,
  }
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
