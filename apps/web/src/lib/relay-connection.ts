import { randomUUID, sign, verify } from "node:crypto"
import * as Sentry from "@sentry/tanstackstart-react"
import { Effect, Fiber, Option, Schema } from "effect"
import { WebSocket } from "ws"

import {
  RelayControlServerMessageSchema,
  applyRelaySnapshotDelta,
  createRelaySnapshotDelta,
  isAuditedRelayControlOperation,
  relayAuthenticationWindowMs,
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlDeadlineMs,
  relayControlMaxFrameBytes,
  relayControlRequestTimeoutMs,
  relayControlProtocol,
  relaySnapshotDeltaFeature,
  relaySnapshotDeltaSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlRequest,
  RelaySnapshot,
  RelaySnapshotDelta,
} from "@workspace/contracts"
import { relayTailscaleStackIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  relayControlEndpoint,
  type RelayEndpoint,
} from "@/lib/relay-control-endpoint"
import { RelayUnavailableError } from "@/effect/errors"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import type { RelayCredentials } from "@/lib/relay-registry"
import { resolveSftpAuthorization } from "@/lib/sftp-authorization"
import { relayControlFailureError } from "@/lib/relay-control-errors"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

export { relayControlEndpoint }
export type { RelayEndpoint }

const MAX_BACKOFF_MS = 30_000
const tailscaleInstanceDetachSchema = z.strictObject({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  mode: z.enum(["prepare", "rollback"]),
  stackIds: z.array(relayTailscaleStackIdSchema).min(1).max(4_096),
})

class RelayRequestTimeoutError extends Error {
  override readonly name = "RelayRequestTimeoutError"
}

export type RelayConnectionStatus =
  | "authenticated"
  | "connecting"
  | "disconnected"
  | "unreachable"

export interface RelayConnectionState {
  lastError: string | null
  status: RelayConnectionStatus
  updatedAt: number
}

declare global {
  var kilnRelayConnections: Map<string, RelayConnection> | undefined
}

const connections = (globalThis.kilnRelayConnections ??= new Map())

export async function relayRpc(
  relay: RelayEndpoint,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs = operation === "instance.delete"
    ? relayControlDeadlineMs(operation)
    : 10_000,
  subject?: string
): Promise<unknown> {
  const effectiveRelay = relayControlEndpoint(relay)
  let connection = connections.get(relay.id)
  // Vite preserves this global registry across SSR reloads. Existing instances
  // remain usable through their own prototype; replacing them based on
  // instanceof lets old and new module generations continuously evict each
  // other while long-lived requests are still active.
  if (connection && !connection.matches(effectiveRelay)) {
    connection.close()
    connections.delete(relay.id)
    connection = undefined
  }
  if (!connection) {
    connection = new RelayConnection(effectiveRelay)
    connections.set(relay.id, connection)
  }
  const result = await runAppEffect(
    `relay.rpc.${operation}`,
    connection.request(operation, payload, timeoutMs, subject)
  )
  if (subject && isAuditedRelayControlOperation(operation)) {
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [relay.id] },
      scope: { relayId: relay.id },
      topics: ["activity"],
      type: "hearth.invalidate",
    })
  }
  return result
}

export function relayConnectionState(relayId: string): RelayConnectionState {
  return (
    connections.get(relayId)?.state ?? {
      lastError: null,
      status: "disconnected",
      updatedAt: Date.now(),
    }
  )
}

export function closeRelayConnection(relayId: string): void {
  const connection = connections.get(relayId)
  connections.delete(relayId)
  connection?.close()
}

class RelayConnection {
  #attempt = 0
  #closed = false
  #connecting: Fiber.Fiber<void, unknown> | null = null
  #credentials: RelayCredentials | null = null
  #pending = new Map<
    string,
    {
      resume: (effect: Effect.Effect<unknown, RelayUnavailableError>) => void
    }
  >()
  #reverseInFlight = new Map<
    string,
    {
      controller: AbortController
      fiber: Fiber.Fiber<void, unknown> | null
    }
  >()
  #hasPushedSnapshot = false
  #pushedSnapshot: RelaySnapshot | null = null
  #eventSequence = 0
  #relay: RelayEndpoint
  #reconnectFiber: Fiber.Fiber<void, unknown> | null = null
  #socket: WebSocket | null = null
  #state: RelayConnectionState = {
    lastError: null,
    status: "disconnected",
    updatedAt: Date.now(),
  }

  constructor(relay: RelayEndpoint) {
    this.#relay = relay
  }

  get state(): RelayConnectionState {
    return this.#state
  }

  matches(relay: RelayEndpoint): boolean {
    return (
      this.#relay.hostname === relay.hostname &&
      this.#relay.port === relay.port &&
      this.#relay.useTls === relay.useTls
    )
  }

  request(
    operation: RelayControlOperation,
    payload: unknown,
    timeoutMs: number,
    subject?: string
  ) {
    return this.#connectEffect().pipe(
      Effect.flatMap(() => {
        if (operation === "relay.snapshot" && this.#hasPushedSnapshot) {
          const snapshot = this.#pushedSnapshot
          this.#hasPushedSnapshot = false
          return Effect.succeed(snapshot)
        }
        const socket = this.#socket
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return relayConnectionFailure("Relay control socket is not connected")
        }
        const id = randomUUID()
        const duration = Math.min(
          Math.max(timeoutMs, 1),
          relayControlDeadlineMs(operation)
        )
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
        return Effect.callback<unknown, RelayUnavailableError>((resume) => {
          this.#pending.set(id, { resume })
          socket.send(JSON.stringify(request), (cause) => {
            if (!cause) return
            this.#pending.delete(id)
            resume(
              relayConnectionFailure(
                cause.message || "Relay request could not be sent",
                cause
              )
            )
          })
          return Effect.sync(() => {
            if (!this.#pending.delete(id)) return
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  id: randomUUID(),
                  replyTo: id,
                  type: "cancel",
                  v: 1,
                })
              )
            }
          })
        }).pipe(
          Effect.timeout(duration),
          Effect.catchTag("TimeoutError", () =>
            relayConnectionFailure(
              `Relay request timed out after ${duration}ms`
            )
          )
        )
      }),
      Effect.withSpan("hearth.relay.request", {
        attributes: {
          "relay.id": this.#relay.id,
          "relay.operation": operation,
        },
      })
    )
  }

  close(): void {
    this.#closed = true
    this.#connecting?.interruptUnsafe()
    this.#connecting = null
    this.#reconnectFiber?.interruptUnsafe()
    this.#reconnectFiber = null
    this.#socket?.close(1000, "Hearth connection closed")
    this.#socket = null
    this.#abortReverseRequests()
    this.#rejectPending(new Error("Relay connection closed"))
    this.#setState("disconnected", null)
  }

  #connectEffect(): Effect.Effect<void, RelayUnavailableError> {
    if (
      this.#socket?.readyState === WebSocket.OPEN &&
      this.#state.status === "authenticated"
    ) {
      return Effect.void
    }
    if (!this.#connecting) {
      let connecting: Fiber.Fiber<void, unknown>
      connecting = forkAppEffect(
        "relay.connection.open",
        this.#openEffect().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (this.#connecting === connecting) {
                this.#connecting = null
              }
            })
          )
        )
      )
      this.#connecting = connecting
    }
    return Fiber.join(this.#connecting).pipe(
      Effect.mapError((cause) =>
        cause instanceof RelayUnavailableError
          ? cause
          : RelayUnavailableError.make({
              message: asError(cause).message,
              cause,
            })
      )
    )
  }

  #openEffect(): Effect.Effect<void, RelayUnavailableError> {
    let socket: WebSocket | null = null
    return Effect.gen({ self: this }, function* () {
      this.#setState("connecting", null)
      this.#eventSequence = 0
      this.#hasPushedSnapshot = false
      this.#pushedSnapshot = null
      this.#socket = null
      const { loadRelayCredentials } = yield* Effect.tryPromise({
        try: () => import("@/lib/relay-registry"),
        catch: (cause) =>
          RelayUnavailableError.make({
            message: "Relay credentials could not be loaded",
            cause,
          }),
      })
      const credentials = yield* Effect.tryPromise({
        try: () => loadRelayCredentials(this.#relay.id),
        catch: (cause) =>
          RelayUnavailableError.make({
            message: asError(cause).message,
            cause,
          }),
      })
      if (this.#closed) return
      this.#credentials = credentials
      const protocol = this.#relay.useTls ? "wss" : "ws"
      const activeSocket = yield* Effect.try({
        try: () =>
          new WebSocket(
            `${protocol}://${formatHost(this.#relay.hostname)}:${this.#relay.port}/v1/socket`,
            relayControlProtocol,
            {
              ca: credentials.caCertificatePem ?? undefined,
              handshakeTimeout: 5_000,
              maxPayload: relayControlMaxFrameBytes,
              perMessageDeflate: false,
              rejectUnauthorized: this.#relay.useTls,
            }
          ),
        catch: (cause) =>
          RelayUnavailableError.make({
            message: asError(cause).message,
            cause,
          }),
      })
      socket = activeSocket
      this.#socket = activeSocket
      yield* this.#authenticateEffect(activeSocket).pipe(
        Effect.timeout(relayAuthenticationWindowMs),
        Effect.catchTag("TimeoutError", () =>
          relayConnectionFailure("Relay authentication timed out")
        )
      )
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          socket?.terminate()
          if (!socket) this.#attempt += 1
          this.#setState("unreachable", cause.message)
          this.#scheduleReconnect()
        }).pipe(Effect.andThen(Effect.fail(cause)))
      )
    )
  }

  #authenticateEffect(
    activeSocket: WebSocket
  ): Effect.Effect<void, RelayUnavailableError> {
    return Effect.callback<void, RelayUnavailableError>((resume) => {
      let authenticated = false
      let challengeAnswered = false
      activeSocket.on("message", (data, binary) => {
        if (binary) {
          resume(
            relayConnectionFailure(
              "Relay sent an unsupported binary control frame"
            )
          )
          return
        }
        const decoded = decodeRelayControlMessage(data.toString())
        if (Option.isNone(decoded)) {
          resume(
            relayConnectionFailure("Relay sent an invalid control message")
          )
          return
        }
        const message = decoded.value
        if (message.type === "auth.challenge") {
          if (challengeAnswered) {
            resume(
              relayConnectionFailure(
                "Relay repeated its authentication challenge"
              )
            )
            return
          }
          const answered = Effect.runSync(
            Effect.try({
              try: () => this.#answerChallenge(activeSocket, message),
              catch: asError,
            }).pipe(
              Effect.match({
                onFailure: (cause) => Option.some(cause),
                onSuccess: () => Option.none<Error>(),
              })
            )
          )
          if (Option.isSome(answered)) {
            resume(
              relayConnectionFailure(answered.value.message, answered.value)
            )
            return
          }
          challengeAnswered = true
          return
        }
        if (message.type === "auth.ready") {
          if (
            !challengeAnswered ||
            message.clientId !== this.#credentials?.clientId
          ) {
            resume(
              relayConnectionFailure(
                "Relay authenticated the wrong Hearth identity"
              )
            )
            return
          }
          this.#attempt = 0
          this.#setState("authenticated", null)
          authenticated = true
          if (this.#hasPushedSnapshot) resume(Effect.void)
          return
        }
        if (!authenticated) {
          resume(
            relayConnectionFailure(
              "Relay sent a control message before authentication"
            )
          )
          activeSocket.close(4401, "Relay authentication is incomplete")
          return
        }
        if (message.type === "event") {
          if (message.seq <= this.#eventSequence) {
            resume(
              relayConnectionFailure("Relay event sequence moved backwards")
            )
            return
          }
          this.#eventSequence = message.seq
          if (message.event === "relay.snapshot") {
            const snapshot = relaySnapshotSchema.safeParse(message.payload)
            if (!snapshot.success) {
              resume(relayConnectionFailure("Relay sent an invalid snapshot"))
              activeSocket.close(4400, "Relay snapshot is invalid")
              return
            }
            const previousSnapshot = this.#pushedSnapshot
            this.#pushedSnapshot = snapshot.data
            this.#hasPushedSnapshot = true
            if (!previousSnapshot) {
              publishRealtimeChange({
                relayId: this.#relay.id,
                type: "relay.snapshot.reset",
              })
            } else {
              const delta = createRelaySnapshotDelta(
                previousSnapshot,
                snapshot.data
              )
              if (delta) {
                publishRealtimeChange({
                  delta,
                  directoryChanged: snapshotDeltaChangesDirectory(
                    previousSnapshot,
                    delta
                  ),
                  relayId: this.#relay.id,
                  type: "relay.snapshot.delta",
                })
              }
            }
            if (authenticated) resume(Effect.void)
          } else if (message.event === "relay.snapshot.delta") {
            const delta = relaySnapshotDeltaSchema.safeParse(message.payload)
            if (!delta.success || !this.#pushedSnapshot) {
              resume(
                relayConnectionFailure("Relay sent an invalid snapshot delta")
              )
              activeSocket.close(4400, "Relay snapshot delta is invalid")
              return
            }
            const previousSnapshot = this.#pushedSnapshot
            this.#pushedSnapshot = applyRelaySnapshotDelta(
              previousSnapshot,
              delta.data
            )
            this.#hasPushedSnapshot = true
            publishRealtimeChange({
              delta: delta.data,
              directoryChanged: snapshotDeltaChangesDirectory(
                previousSnapshot,
                delta.data
              ),
              relayId: this.#relay.id,
              type: "relay.snapshot.delta",
            })
          }
          return
        }
        this.#handleMessage(message)
      })
      activeSocket.once("error", (cause) => {
        resume(relayConnectionFailure(cause.message, cause))
      })
      activeSocket.once("close", (code, reason) => {
        const error = new Error(
          `Relay connection closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`
        )
        this.#socket = null
        this.#abortReverseRequests()
        this.#rejectPending(error)
        if (this.#closed) {
          this.#setState("disconnected", null)
          resume(relayConnectionFailure(error.message, error))
          return
        }
        this.#setState("unreachable", error.message)
        this.#attempt += 1
        this.#scheduleReconnect()
        resume(relayConnectionFailure(error.message, error))
      })
      return Effect.sync(() => {
        if (
          this.#state.status !== "authenticated" &&
          activeSocket.readyState !== WebSocket.CLOSED
        ) {
          activeSocket.terminate()
        }
      })
    })
  }

  #answerChallenge(socket: WebSocket, challenge: RelayAuthChallenge): void {
    const credentials = this.#credentials
    if (!credentials) throw new Error("Relay credentials are unavailable")
    if (
      challenge.relayId !== this.#relay.id ||
      !verify(
        null,
        Buffer.from(relayAuthChallengeTranscript(challenge)),
        credentials.relayPublicKeyPem,
        Buffer.from(challenge.signature, "base64url")
      )
    ) {
      throw new Error("Relay identity challenge could not be verified")
    }
    socket.send(
      JSON.stringify({
        clientId: credentials.clientId,
        features: [relaySnapshotDeltaFeature],
        signature: sign(
          null,
          Buffer.from(
            relayAuthResponseTranscript(challenge, credentials.clientId)
          ),
          credentials.clientPrivateKeyPem
        ).toString("base64url"),
        type: "auth.response",
        v: 1,
      })
    )
  }

  #handleMessage(message: typeof RelayControlServerMessageSchema.Type): void {
    if (message.type === "response") {
      const pending = this.#pending.get(message.replyTo)
      if (!pending) return
      this.#pending.delete(message.replyTo)
      pending.resume(Effect.succeed(message.payload))
      return
    }
    if (message.type === "error" && message.replyTo) {
      const pending = this.#pending.get(message.replyTo)
      if (!pending) return
      this.#pending.delete(message.replyTo)
      pending.resume(Effect.fail(relayControlFailureError(message)))
      return
    }
    if (message.type === "cancel") {
      const inFlight = this.#reverseInFlight.get(message.replyTo)
      inFlight?.controller.abort()
      inFlight?.fiber?.interruptUnsafe()
      return
    }
    if (message.type === "request") {
      const controller = new AbortController()
      const inFlight: {
        controller: AbortController
        fiber: Fiber.Fiber<void, unknown> | null
      } = { controller, fiber: null }
      this.#reverseInFlight.set(message.id, inFlight)
      const socket = this.#socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        this.#reverseInFlight.delete(message.id)
        return
      }
      inFlight.fiber = forkAppEffect(
        `relay.reverse.${message.operation}`,
        Effect.yieldNow.pipe(
          Effect.andThen(
            this.#handleRelayRequestEffect(message, controller, socket)
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (this.#reverseInFlight.get(message.id) === inFlight) {
                this.#reverseInFlight.delete(message.id)
              }
            })
          )
        )
      )
    }
  }

  #handleRelayRequestEffect(
    request: RelayControlRequest,
    controller: AbortController,
    socket: WebSocket
  ): Effect.Effect<void> {
    const duration = relayControlRequestTimeoutMs(request, Date.now())
    const operation =
      duration === null
        ? reverseRequestFailure("Relay request timeout is invalid")
        : this.#executeRelayRequestEffect(request, controller, socket).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                controller.abort()
              })
            ),
            Effect.timeout(duration),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new RelayRequestTimeoutError("Relay request timed out")
              )
            )
          )
    return operation.pipe(
      Effect.catch((cause) => {
        const error = asError(cause)
        const cancelled =
          controller.signal.aborted || error instanceof RelayRequestTimeoutError
        return Effect.sync(() => {
          if (!cancelled) {
            Sentry.captureException(error, {
              tags: {
                "kiln.operation": request.operation,
                "kiln.relay_id": this.#relay.id,
              },
            })
          }
        }).pipe(
          Effect.andThen(
            socket.readyState !== WebSocket.OPEN
              ? Effect.void
              : sendSocketEffect(socket, {
                  code: cancelled
                    ? "request_cancelled"
                    : "hearth_operation_failed",
                  id: randomUUID(),
                  message: error.message,
                  replyTo: request.id,
                  retryable: false,
                  type: "error",
                  v: 1,
                }).pipe(
                  Effect.catch((sendCause) =>
                    Effect.logWarning(
                      "Relay reverse-request response failed",
                      sendCause
                    )
                  )
                )
          )
        )
      })
    )
  }

  #executeRelayRequestEffect(
    request: RelayControlRequest,
    controller: AbortController,
    socket: WebSocket
  ): Effect.Effect<void, Error> {
    if (request.operation === "hearth.tailscale.instance.detach") {
      return Effect.gen({ self: this }, function* () {
        const input = yield* Effect.try({
          try: () => tailscaleInstanceDetachSchema.parse(request.payload),
          catch: asError,
        })
        const { synchronizeTailscaleInstanceDeletion } =
          yield* Effect.tryPromise({
            try: () => import("@/server/tailscale-instance-deletion"),
            catch: asError,
          })
        yield* Effect.tryPromise({
          try: () =>
            synchronizeTailscaleInstanceDeletion(
              {
                ...input,
                relayId: this.#relay.id,
              },
              (relay, operation, payload, timeoutMs) =>
                relayRpc(relay, operation, payload, timeoutMs, request.subject),
              controller.signal
            ),
          catch: asError,
        })
        yield* ensureRelayRequestActive(controller.signal)
        yield* sendSocketEffect(socket, {
          id: randomUUID(),
          payload: { synchronized: true },
          replyTo: request.id,
          type: "response",
          v: 1,
        })
      })
    }
    if (request.operation !== "sftp.authorization.resolve") {
      return reverseRequestFailure(
        "Relay operation is not available from Hearth"
      )
    }
    const payload = objectRecord(request.payload)
    const username = payload.username
    const credential = payload.credential
    if (typeof username !== "string") {
      return reverseRequestFailure("SFTP username is required")
    }
    if (credential !== undefined && typeof credential !== "string") {
      return reverseRequestFailure("SFTP credential is invalid")
    }
    return Effect.tryPromise({
      try: () => resolveSftpAuthorization(this.#relay.id, username, credential),
      catch: asError,
    }).pipe(
      Effect.flatMap((authorization) =>
        sendSocketEffect(socket, {
          id: randomUUID(),
          payload: authorization,
          replyTo: request.id,
          type: "response",
          v: 1,
        })
      )
    )
  }

  #rejectPending(cause: Error): void {
    for (const pending of this.#pending.values()) {
      pending.resume(relayConnectionFailure(cause.message, cause))
    }
    this.#pending.clear()
  }

  #abortReverseRequests(): void {
    for (const { controller, fiber } of this.#reverseInFlight.values()) {
      controller.abort()
      fiber?.interruptUnsafe()
    }
    this.#reverseInFlight.clear()
  }

  #setState(status: RelayConnectionStatus, lastError: string | null): void {
    const becameAuthenticated =
      status === "authenticated" && this.#state.status !== "authenticated"
    const wasReachable = this.#state.status === "authenticated"
    const isReachable = status === "authenticated"
    this.#state = { lastError, status, updatedAt: Date.now() }
    Sentry.addBreadcrumb({
      category: "relay.connection",
      data: { relayId: this.#relay.id },
      level: status === "unreachable" ? "warning" : "info",
      message: status,
    })
    if (
      wasReachable !== isReachable &&
      connections.get(this.#relay.id) === this
    ) {
      publishRealtimeChange({
        relayId: this.#relay.id,
        status: isReachable ? "connected" : "unreachable",
        type: "relay.state",
      })
    }
    if (becameAuthenticated) {
      forkAppEffect(
        "backups.reconcileOnConnect",
        Effect.tryPromise({
          try: async () => {
            const { reconcileBackupsAfterRelayConnect } =
              await import("@/lib/backup-reconciliation")
            await reconcileBackupsAfterRelayConnect(this.#relay.id)
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Backup reconciliation after Relay connect failed",
              { cause, relayId: this.#relay.id }
            )
          )
        )
      )
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectFiber) return
    const maximum = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt)
    const delay = Math.max(
      1,
      Math.floor(Math.random() * Math.max(maximum, 500))
    )
    let reconnecting: Fiber.Fiber<void, unknown>
    reconnecting = forkAppEffect(
      "relay.connection.reconnect",
      Effect.sleep(delay).pipe(
        Effect.andThen(Effect.suspend(() => this.#connectEffect())),
        Effect.catch(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#reconnectFiber === reconnecting) {
              this.#reconnectFiber = null
            }
          })
        )
      )
    )
    this.#reconnectFiber = reconnecting
  }
}

function snapshotDeltaChangesDirectory(
  previous: RelaySnapshot,
  delta: RelaySnapshotDelta
): boolean {
  if (delta.deletedInstanceIds.length > 0) return true
  return delta.instances.some(
    (instance) =>
      !previous.instances.some((candidate) => candidate.id === instance.id)
  )
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Relay connection failed")
}

function reverseRequestFailure(message: string): Effect.Effect<never, Error> {
  return Effect.fail(new Error(message))
}

function ensureRelayRequestActive(
  signal: AbortSignal
): Effect.Effect<void, RelayRequestTimeoutError> {
  return signal.aborted
    ? Effect.fail(new RelayRequestTimeoutError("Relay request was cancelled"))
    : Effect.void
}

function sendSocketEffect(
  socket: WebSocket,
  message: unknown
): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      socket.send(JSON.stringify(message))
    },
    catch: asError,
  })
}

function relayConnectionFailure(
  message: string,
  cause?: unknown
): Effect.Effect<never, RelayUnavailableError> {
  return Effect.fail(
    RelayUnavailableError.make({
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  )
}

const decodeRelayControlMessage = (
  text: string
): Option.Option<typeof RelayControlServerMessageSchema.Type> =>
  Option.flatMap(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
    Schema.decodeUnknownOption(RelayControlServerMessageSchema)
  )

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
