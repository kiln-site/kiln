import { randomUUID, sign, verify } from "node:crypto"
import {
  Effect,
  Fiber,
  Option,
  Result,
  Schema,
  Semaphore,
  Tracer,
} from "effect"
import { HttpTraceContext } from "effect/http"
import { WebSocket } from "ws"

import {
  RelayControlServerMessageSchema,
  applyRelaySnapshotDelta,
  createRelaySnapshotDelta,
  isAuditedRelayControlOperation,
  relayAuthenticationWindowMs,
  relayBrowserCapabilityV2Feature,
  relayBrowserLeaseRenewalV1Feature,
  relayFileRequestReplayV1Feature,
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlDeadlineMs,
  relayControlMaxFrameBytes,
  relayControlOperationChanges,
  relayControlOperationRefusedWhilePaused,
  RelayOperationLookupSchema,
  relayControlRequestTimeoutMs,
  relayControlProtocol,
  relaySnapshotControlDelta,
  relaySnapshotDeltaFeature,
  relaySnapshotDeltaSchema,
  relaySnapshotNodeResourcesFeature,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlRequest,
  RelayNode,
  RelayProxyBrowserMetadata,
  RelayProxyMode,
  RelaySnapshot,
  RelaySnapshotDelta,
  RelaySystemUpdate,
} from "@workspace/contracts"
import {
  hearthDatabaseTerminalOutputSchema,
  relayTailscaleStackIdSchema,
  tailscaleMemberIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  relayControlEndpoint,
  type RelayEndpoint,
} from "@/lib/relay-control-endpoint"
import type { Database } from "@/effect/database"
import { RelayUnavailableError } from "@/effect/errors"
import { loadedKilnInstallationId } from "@/effect/installation"
import { forkAppEffect, reportAppError, runAppEffect } from "@/effect/runtime"
import { ensuringPromise, forkPromise, promiseEffect } from "@/effect/promise"
import type { RelayCredentials } from "@/lib/relay-registry"
import { resolveSftpAuthorization } from "@/lib/sftp-authorization"
import { relayControlFailureError } from "@/lib/relay-control-errors"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayPausedError } from "@/lib/relay-availability"

export { relayControlEndpoint }
export type { RelayEndpoint }

const MAX_BACKOFF_MS = 30_000
const tailscaleInstanceDetachSchema = z.strictObject({
  // A server, or an app's service being deleted.
  instanceId: tailscaleMemberIdSchema,
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

interface BrowserAuthorizationReadiness {
  promise: Promise<number>
  reject: (cause: Error) => void
  resolve: (issuerGeneration: number) => void
}

interface ReportedRelayUpdates {
  // Set while the Relay is away after reporting them; when it fires, a
  // running update stops counting.
  expiry?: ReturnType<typeof setTimeout>
  expired?: true
  updates: ReadonlyArray<RelaySystemUpdate>
}

declare global {
  var kilnRelayConnections: Map<string, RelayConnection> | undefined
  var kilnRelayUpdates: Map<string, ReportedRelayUpdates> | undefined
}

const connections = (globalThis.kilnRelayConnections ??= new Map())
// The updates each Relay reported in its latest snapshot. A Relay reports them
// again on every connection, so a Hearth replaced mid-update learns how they
// went from the Relays. They outlive the connection, so a Relay replacing
// itself is still shown updating while it's away, for a while.
const relayUpdates = (globalThis.kilnRelayUpdates ??= new Map())
const ABSENT_RELAY_UPDATE_MS = 15 * 60_000

/**
 * Sends one request to a Relay. A change gets an operation ID, and one a
 * person or CLI credential asked for (`subject`) is recorded in Hearth's
 * audit before it's sent and given its outcome after. A paused Relay
 * (`enabled: false`) is sent no changes.
 */
export async function relayRpc(
  relay: RelayEndpoint & { readonly enabled?: boolean },
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs = operation === "instance.delete"
    ? relayControlDeadlineMs(operation)
    : 10_000,
  subject?: string,
  signal?: AbortSignal
): Promise<unknown> {
  const changes = relayControlOperationChanges(operation)
  if (
    relay.enabled === false &&
    relayControlOperationRefusedWhilePaused(operation)
  ) {
    throw relayPausedError()
  }
  const operationId = changes ? randomUUID() : undefined
  const audit =
    operationId !== undefined && subject !== undefined
      ? auditChange((hearthAudit) =>
          hearthAudit.recordRelayChangeStarted({
            operation,
            operationId,
            payload,
            relayId: relay.id,
            subject,
          })
        )
      : null
  if (audit) await audit.started
  const result = await Effect.runPromise(
    Effect.result(
      promiseEffect(() =>
        relaySend(
          relay,
          operation,
          payload,
          timeoutMs,
          subject,
          signal,
          operationId
        )
      )
    )
  )
  if (audit && operationId) {
    audit.finish((hearthAudit) =>
      hearthAudit.recordRelayChangeFinished({
        operationId,
        ...(Result.isSuccess(result)
          ? { outcome: "succeeded" }
          : auditFailure(result.failure)),
      })
    )
  }
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

function connectionFor(relay: RelayEndpoint): RelayConnection {
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
  return connection
}

/**
 * Tells a Relay whether this Hearth holds it paused, connecting to it if
 * need be. The connection keeps telling it, on every connect and while the
 * Relay reports otherwise, so a pause or resume it missed still arrives.
 */
export async function setRelayPause(
  relay: RelayEndpoint,
  paused: boolean
): Promise<void> {
  await runAppEffect("relay.pause.set", connectionFor(relay).holdPaused(paused))
}

async function relaySend(
  relay: RelayEndpoint,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs: number,
  subject: string | undefined,
  signal: AbortSignal | undefined,
  operationId: string | undefined
): Promise<unknown> {
  const connection = connectionFor(relay)
  const result = await runAppEffect(
    `relay.rpc.${operation}`,
    connection.request(operation, payload, timeoutMs, subject, operationId),
    { signal }
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

export function isRelayUpdating(relayId: string): boolean {
  const reported = relayUpdates.get(relayId)
  return (
    reported?.expired === undefined &&
    reported?.updates.some(isRunningRelayUpdate) === true
  )
}

/**
 * The updates a Relay reported, running or finished, or null when it hasn't
 * reported any to this Hearth process or predates reporting them.
 */
export function relaySystemUpdates(
  relayId: string
): ReadonlyArray<RelaySystemUpdate> | null {
  return relayUpdates.get(relayId)?.updates ?? null
}

/**
 * Whether a Relay's reported updates are current: `reporting` once this
 * process has its snapshot on the current connection, `unsupported` when that
 * snapshot has none because the Relay predates reporting them, and
 * `unavailable` until then. What it reported before going away is kept, but
 * isn't current.
 */
export function relayUpdateReportState(
  relayId: string
): "reporting" | "unavailable" | "unsupported" {
  if (!connections.get(relayId)?.pushedNode) return "unavailable"
  return relayUpdates.has(relayId) ? "reporting" : "unsupported"
}

function rememberRelayUpdates(relayId: string, node: RelayNode): void {
  const wasUpdating = isRelayUpdating(relayId)
  const previous = relayUpdates.get(relayId)
  clearTimeout(previous?.expiry)
  if (node.updates) {
    relayUpdates.set(relayId, { updates: node.updates })
  } else {
    relayUpdates.delete(relayId)
  }
  if (isRelayUpdating(relayId) !== wasUpdating) publishRelayState(relayId)
}

// A Relay that goes away mid-update stops counting as updating after a
// while, and that is announced then.
function noteRelayUpdatesAbsent(relayId: string): void {
  const reported = relayUpdates.get(relayId)
  if (!reported || reported.expiry || !isRelayUpdating(relayId)) return
  reported.expiry = setTimeout(() => {
    reported.expired = true
    if (relayUpdates.get(relayId) === reported) publishRelayState(relayId)
  }, ABSENT_RELAY_UPDATE_MS)
  reported.expiry.unref()
}

// Updates stay in Hearth's report cache: Hearth's own are only for platform
// administrators, and a browser has no use for a phase change.
function withoutUpdates(node: RelayNode): RelayNode {
  const { updates: _updates, ...rest } = node
  return rest
}

function isRunningRelayUpdate(update: RelaySystemUpdate): boolean {
  return update.component === "relay" && update.status === "running"
}

function publishRelayState(relayId: string): void {
  publishRealtimeChange({
    relayId,
    status:
      relayConnectionState(relayId).status === "authenticated"
        ? "connected"
        : "unreachable",
    type: "relay.state",
    updating: isRelayUpdating(relayId),
  })
}

/**
 * Whether this process has failed to reach the Relay since it last
 * authenticated. A first connection after startup is still in progress, not
 * failing.
 */
export function relayConnectionFailing(relayId: string): boolean {
  return connections.get(relayId)?.failing ?? false
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

/**
 * The Relay node last pushed over this Hearth process's own control socket.
 * Each process keeps its own connections, so this is null until this process
 * has authenticated with the Relay. Callers must authorize the reader first.
 */
export function relayConnectionNode(relayId: string): RelayNode | null {
  return connections.get(relayId)?.pushedNode ?? null
}

/** The proxy mode from the snapshot this Relay last pushed, if any. */
export function relayConnectionProxyMode(
  relayId: string
): RelayProxyMode | null {
  return connections.get(relayId)?.pushedSnapshot?.relay?.proxyMode ?? null
}

/**
 * Whether the Relay reports itself paused, by this Hearth or another, as of
 * its last snapshot here. False while this process isn't connected to it.
 */
export function relayReportsPaused(relayId: string): boolean {
  return connections.get(relayId)?.reportsPaused === true
}

/**
 * Whether the Relay has this Hearth's pause: it reports itself paused, or,
 * while away, it took the pause when last connected.
 */
export function relayConfirmsPause(relayId: string): boolean {
  return connections.get(relayId)?.confirmsPause === true
}

export function relayConnectionIds(): ReadonlyArray<string> {
  return Array.from(connections.keys())
}

export function relayConnectionInstances(
  relayId: string
): ReadonlyArray<RelaySnapshot["instances"][number]> | null {
  return connections.get(relayId)?.pushedInstances ?? null
}

/**
 * The snapshot the Relay last pushed over this Hearth process's own control
 * socket, kept current by its deltas. Null until this process has
 * authenticated with the Relay. Callers must authorize the reader first.
 */
export function relayConnectionSnapshot(relayId: string): RelaySnapshot | null {
  return connections.get(relayId)?.pushedSnapshot ?? null
}

export function relayConnectionBrowserMetadata(
  relayId: string
): RelayProxyBrowserMetadata | null {
  return connections.get(relayId)?.browserMetadata ?? null
}

export function relayConnectionFeatures(relayId: string): ReadonlySet<string> {
  return connections.get(relayId)?.features ?? new Set()
}

export function relayBrowserAuthorizationReady(
  relayId: string,
  minimumIssuerGeneration: number
): Promise<number> {
  const connection = connections.get(relayId)
  return connection
    ? connection.ensureBrowserAuthorizationReady(minimumIssuerGeneration)
    : Promise.reject(new Error("Relay browser authorization is not connected"))
}

export function closeRelayConnection(relayId: string): void {
  const connection = connections.get(relayId)
  connections.delete(relayId)
  connection?.close()
  clearTimeout(relayUpdates.get(relayId)?.expiry)
  relayUpdates.delete(relayId)
}

// The trace context the Relay's work for a request continues, so it joins
// Hearth's trace and follows its sampling. Without a configured tracer Hearth
// keeps no traces, yet its spans still claim to be sampled, so it sends none
// and the Relay samples on its own.
const relayTraceparent = Effect.gen(function* () {
  if ((yield* Effect.tracer) === Tracer.nativeTracer) return undefined
  const span = yield* Effect.option(Effect.currentSpan)
  return Option.isSome(span)
    ? HttpTraceContext.toHeaders(span.value).traceparent
    : undefined
})

class RelayConnection {
  #attempt = 0
  #closed = false
  #connecting: Fiber.Fiber<void, unknown> | null = null
  #credentials: RelayCredentials | null = null
  #pending = new Map<string, PendingRequest>()
  // Changes whose connection dropped before they answered, by operation ID.
  // They're settled by asking the Relay how each went once it's back.
  #unsettled = new Map<string, UnsettledChange>()
  #settling = false
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
  #features = new Set<string>()
  #browserAuthorizationAdvance: Promise<number> | null = null
  #browserAuthorizationReadiness: BrowserAuthorizationReadiness | null = null
  #browserIssuerGeneration = 0
  #relay: RelayEndpoint
  #reconnectFiber: Fiber.Fiber<void, unknown> | null = null
  #auditFiber: Fiber.Fiber<void, unknown> | null = null
  // Whether this Hearth wants the Relay paused, and what the Relay last
  // took from it, so the pause loop knows when to tell it again.
  #wantsPaused: boolean | null = null
  #toldPaused: boolean | null = null
  #pauseFiber: Fiber.Fiber<void, unknown> | null = null
  // One pause write at a time, so an older one can't land after a newer.
  readonly #pauseWrites = Semaphore.makeUnsafe(1)
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

  get failing(): boolean {
    return (
      this.#state.status !== "authenticated" &&
      (this.#attempt > 0 || this.#state.status === "unreachable")
    )
  }

  /** The node from the pushed snapshot, without consuming it for RPC reads. */
  get pushedNode(): RelayNode | null {
    return this.#state.status === "authenticated"
      ? (this.#pushedSnapshot?.node ?? null)
      : null
  }

  get pushedSnapshot(): RelaySnapshot | null {
    return this.#state.status === "authenticated" ? this.#pushedSnapshot : null
  }

  get reportsPaused(): boolean {
    return this.pushedSnapshot?.relay?.paused === true
  }

  get confirmsPause(): boolean {
    return this.#state.status === "authenticated"
      ? this.reportsPaused
      : this.#toldPaused === true
  }

  /**
   * Sets whether this Hearth holds the Relay paused, and tells it now. If it
   * can't be reached, connecting tells it.
   */
  holdPaused(paused: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#wantsPaused = paused
      // What it took before no longer answers whether it has this.
      if (this.#toldPaused !== paused) this.#toldPaused = null
      return this.#connectEffect().pipe(
        Effect.andThen(this.#tellPause(false)),
        Effect.ignore
      )
    })
  }

  // Tells the Relay whether this Hearth holds it paused, unless it already
  // took that: a pause it reports, or a resume, since another Hearth may
  // still hold it paused.
  #tellPause(always: boolean): Effect.Effect<void> {
    return this.#pauseWrites.withPermit(
      Effect.suspend(() => {
        const paused = this.#wantsPaused
        if (paused === null || this.#state.status !== "authenticated") {
          return Effect.void
        }
        if (
          !always &&
          this.#toldPaused === paused &&
          (!paused || this.reportsPaused)
        ) {
          return Effect.void
        }
        return this.request("relay.pause.write", { paused }, 10_000).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (this.#wantsPaused === paused) this.#toldPaused = paused
            })
          ),
          Effect.catch((cause) =>
            Effect.sync(() => {
              // It may or may not have taken it, so tell it again next time.
              if (this.#wantsPaused === paused) this.#toldPaused = null
            }).pipe(
              Effect.andThen(
                Effect.logWarning("Relay pause sync failed", {
                  cause,
                  relayId: this.#relay.id,
                })
              )
            )
          ),
          Effect.asVoid
        )
      })
    )
  }

  // Lets browsers know when the Relay's pause changes.
  #noticePause(previous: RelaySnapshot | null): void {
    const was = previous?.relay?.paused === true
    const is = this.#pushedSnapshot?.relay?.paused === true
    if (was === is && (previous || !is)) return
    publishRealtimeChange({ relayId: this.#relay.id, type: "relay.metadata" })
  }

  get pushedInstances(): ReadonlyArray<
    RelaySnapshot["instances"][number]
  > | null {
    return this.#state.status === "authenticated"
      ? (this.#pushedSnapshot?.instances ?? null)
      : null
  }

  get browserMetadata(): RelayProxyBrowserMetadata | null {
    if (this.#state.status !== "authenticated") return null
    const relay = this.#pushedSnapshot?.relay
    return relay?.browserOrigin && relay.proxyMode
      ? { browserOrigin: relay.browserOrigin, mode: relay.proxyMode }
      : null
  }

  get features(): ReadonlySet<string> {
    return this.#state.status === "authenticated" ? this.#features : new Set()
  }

  get browserAuthorizationReadiness(): BrowserAuthorizationReadiness | null {
    return this.#state.status === "authenticated"
      ? this.#browserAuthorizationReadiness
      : null
  }

  async ensureBrowserAuthorizationReady(
    minimumIssuerGeneration: number
  ): Promise<number> {
    const readiness = this.browserAuthorizationReadiness
    if (!readiness) {
      throw new Error("Relay browser authorization is not connected")
    }
    const initialGeneration = await readiness.promise
    if (
      this.browserAuthorizationReadiness !== readiness ||
      this.#socket?.readyState !== WebSocket.OPEN
    ) {
      throw new Error("Relay browser authorization connection changed")
    }
    this.#browserIssuerGeneration = Math.max(
      this.#browserIssuerGeneration,
      initialGeneration
    )
    while (this.#browserIssuerGeneration < minimumIssuerGeneration) {
      let advance = this.#browserAuthorizationAdvance
      if (!advance) {
        const requestedGeneration = minimumIssuerGeneration
        advance = import("@/lib/authorization-delivery")
          .then(({ synchronizeRelayIssuerGenerationMinimum }) =>
            synchronizeRelayIssuerGenerationMinimum(
              this.#relay.id,
              requestedGeneration
            )
          )
          .then((issuerGeneration) => {
            if (issuerGeneration === null) {
              throw new Error(
                "Relay did not synchronize its browser issuer generation"
              )
            }
            return issuerGeneration
          })
        this.#browserAuthorizationAdvance = advance
      }
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- generation advances must remain serialized per control connection
      const issuerGeneration = await ensuringPromise(
        () => advance,
        () => {
          if (
            this.browserAuthorizationReadiness === readiness &&
            this.#browserAuthorizationAdvance === advance
          ) {
            this.#browserAuthorizationAdvance = null
          }
        }
      )
      if (
        this.browserAuthorizationReadiness !== readiness ||
        this.#socket?.readyState !== WebSocket.OPEN
      ) {
        throw new Error("Relay browser authorization connection changed")
      }
      this.#browserIssuerGeneration = Math.max(
        this.#browserIssuerGeneration,
        issuerGeneration
      )
    }
    return this.#browserIssuerGeneration
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
    subject?: string,
    // Given by relayRpc for changes, so Hearth's audit can name them too.
    operationId: string | undefined = relayControlOperationChanges(operation)
      ? randomUUID()
      : undefined
  ) {
    return this.#connectEffect().pipe(
      Effect.andThen(relayTraceparent),
      Effect.flatMap((traceparent) => {
        if (operation === "relay.snapshot" && this.#hasPushedSnapshot) {
          const snapshot = this.#pushedSnapshot
          this.#hasPushedSnapshot = false
          return Effect.succeed(snapshot)
        }
        const socket = this.#socket
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return relayConnectionFailure("Relay control socket is not connected")
        }
        if (this.#pending.size >= 32) {
          return relayConnectionFailure(
            "Relay control request limit reached; retry after pending work completes"
          )
        }
        const id = randomUUID()
        const duration = Math.min(
          Math.max(timeoutMs, 1),
          relayControlDeadlineMs(operation)
        )
        // A change keeps one ID across reconnects, so its outcome can be
        // looked up if its answer is lost.
        const deadline = Date.now() + duration
        const request: RelayControlRequest = {
          deadline,
          id,
          operation,
          ...(operationId ? { operationId } : {}),
          payload,
          ...(subject ? { subject } : {}),
          timeoutMs: duration,
          ...(traceparent ? { traceparent } : {}),
          type: "request",
          v: 1,
        }
        return Effect.callback<unknown, RelayUnavailableError>((resume) => {
          this.#pending.set(id, { deadline, operationId, resume })
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
            if (operationId) this.#unsettled.delete(operationId)
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
            operationId
              ? unknownOutcome(
                  "The Relay didn't finish this in time. It may still finish, so check the result before trying again."
                )
              : relayConnectionFailure(
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
    this.#auditFiber?.interruptUnsafe()
    this.#auditFiber = null
    this.#pauseFiber?.interruptUnsafe()
    this.#pauseFiber = null
    this.#socket?.close(1000, "Hearth connection closed")
    this.#socket = null
    this.#features.clear()
    this.#browserAuthorizationAdvance = null
    this.#browserIssuerGeneration = 0
    this.#rejectBrowserAuthorizationReadiness(
      new Error("Relay connection closed")
    )
    this.#abortReverseRequests()
    this.#rejectPending(new Error("Relay connection closed"))
    for (const change of this.#unsettled.values()) {
      change.resume(
        unknownOutcome(
          "Hearth closed its connection to this Relay before the change finished. Check the result before trying again."
        )
      )
    }
    this.#unsettled.clear()
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
      this.#browserAuthorizationAdvance = null
      this.#browserIssuerGeneration = 0
      this.#rejectBrowserAuthorizationReadiness(
        new Error("Relay connection was replaced")
      )
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
          this.#features = new Set(message.features ?? [])
          this.#browserAuthorizationReadiness = browserAuthorizationReadiness()
          this.#setState("authenticated", null)
          const synchronizeBrowserAuthorization = () => {
            if (
              this.#socket !== activeSocket ||
              activeSocket.readyState !== WebSocket.OPEN
            ) {
              return
            }
            const readiness = this.#browserAuthorizationReadiness
            forkPromise(
              async () => {
                const {
                  synchronizeRelayIssuerGeneration,
                  wakeAuthorizationDelivery,
                } = await import("@/lib/authorization-delivery")
                if (
                  this.#features.has(relayBrowserCapabilityV2Feature) &&
                  message.browserIssuerGeneration === undefined
                ) {
                  throw new Error("Relay omitted its browser issuer generation")
                }
                const issuerGeneration =
                  message.browserIssuerGeneration !== undefined
                    ? await synchronizeRelayIssuerGeneration(
                        this.#relay.id,
                        message.browserIssuerGeneration
                      )
                    : 0
                if (
                  this.#socket !== activeSocket ||
                  this.#browserAuthorizationReadiness !== readiness
                ) {
                  readiness?.reject(
                    new Error("Relay browser authorization connection changed")
                  )
                  return
                }
                wakeAuthorizationDelivery(this.#relay.id)
                this.#browserIssuerGeneration = Math.max(
                  this.#browserIssuerGeneration,
                  issuerGeneration
                )
                readiness?.resolve(issuerGeneration)
              },
              (cause) => {
                reportAppError(cause, {
                  operation: "browser-authorization-sync",
                })
                // A temporary Hearth DB failure must not strand a Relay whose
                // durable authorization state rolled back. Retry only while
                // this exact authenticated control socket is still current.
                if (
                  this.#socket !== activeSocket ||
                  activeSocket.readyState !== WebSocket.OPEN ||
                  this.#browserAuthorizationReadiness !== readiness
                ) {
                  this.#rejectBrowserAuthorizationReadiness(cause, readiness)
                  return
                }
                this.#rejectBrowserAuthorizationReadiness(cause, readiness)
                this.#browserAuthorizationReadiness =
                  browserAuthorizationReadiness()
                const retry = setTimeout(
                  synchronizeBrowserAuthorization,
                  1_000 + Math.floor(Math.random() * 2_000)
                )
                retry.unref()
              }
            )
          }
          synchronizeBrowserAuthorization()
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
            rememberRelayUpdates(this.#relay.id, snapshot.data.node)
            const pushed = {
              ...snapshot.data,
              node: withoutUpdates(snapshot.data.node),
            }
            this.#pushedSnapshot = pushed
            this.#hasPushedSnapshot = true
            this.#noticePause(previousSnapshot)
            if (!previousSnapshot) {
              publishRealtimeChange({
                relayId: this.#relay.id,
                type: "relay.snapshot.reset",
              })
            } else {
              const delta = createRelaySnapshotDelta(previousSnapshot, pushed)
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
            const parsed = relaySnapshotDeltaSchema.safeParse(message.payload)
            if (!parsed.success || !this.#pushedSnapshot) {
              resume(
                relayConnectionFailure("Relay sent an invalid snapshot delta")
              )
              activeSocket.close(4400, "Relay snapshot delta is invalid")
              return
            }
            const { node, ...changes } = parsed.data
            if (node) rememberRelayUpdates(this.#relay.id, node)
            const delta = {
              ...changes,
              ...(node ? { node: withoutUpdates(node) } : {}),
            }
            const previousSnapshot = this.#pushedSnapshot
            this.#pushedSnapshot = applyRelaySnapshotDelta(
              previousSnapshot,
              delta
            )
            this.#hasPushedSnapshot = true
            this.#noticePause(previousSnapshot)
            // Resource-only node samples refresh the cached snapshot without
            // waking browsers on the fleet-wide realtime channel.
            const controlDelta = relaySnapshotControlDelta(
              previousSnapshot,
              delta
            )
            if (controlDelta) {
              publishRealtimeChange({
                delta: controlDelta,
                directoryChanged: snapshotDeltaChangesDirectory(
                  previousSnapshot,
                  controlDelta
                ),
                relayId: this.#relay.id,
                type: "relay.snapshot.delta",
              })
            }
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
        this.#auditFiber?.interruptUnsafe()
        this.#auditFiber = null
        this.#pauseFiber?.interruptUnsafe()
        this.#pauseFiber = null
        this.#rejectBrowserAuthorizationReadiness(error)
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

  #rejectBrowserAuthorizationReadiness(
    cause: unknown,
    expected = this.#browserAuthorizationReadiness
  ): void {
    expected?.reject(asError(cause))
    if (this.#browserAuthorizationReadiness === expected) {
      this.#browserAuthorizationReadiness = null
    }
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
    // Relays save it, so the whole installation shares Hearth's ID.
    const installationId = loadedKilnInstallationId()
    socket.send(
      JSON.stringify({
        clientId: credentials.clientId,
        features: [
          relaySnapshotDeltaFeature,
          relaySnapshotNodeResourcesFeature,
          relayBrowserCapabilityV2Feature,
          relayBrowserLeaseRenewalV1Feature,
          relayFileRequestReplayV1Feature,
        ],
        signature: sign(
          null,
          Buffer.from(
            relayAuthResponseTranscript(challenge, credentials.clientId)
          ),
          credentials.clientPrivateKeyPem
        ).toString("base64url"),
        type: "auth.response",
        v: 1,
        ...(installationId ? { installationId } : {}),
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
            reportAppError(error, {
              operation: request.operation,
              attributes: { "kiln.relay_id": this.#relay.id },
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
    if (request.operation === "hearth.database.terminal.output") {
      return Effect.gen({ self: this }, function* () {
        const output = yield* Effect.try({
          try: () => hearthDatabaseTerminalOutputSchema.parse(request.payload),
          catch: asError,
        })
        const { deliverDatabaseTerminalOutput } = yield* Effect.tryPromise({
          try: () => import("@/server/database-terminal-hub"),
          catch: asError,
        })
        yield* sendSocketEffect(socket, {
          id: randomUUID(),
          payload: deliverDatabaseTerminalOutput(this.#relay.id, output),
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

  // Requests can't answer once their connection is gone. Changes wait to be
  // looked up after it's back; everything else fails now.
  #rejectPending(cause: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.operationId && !this.#closed) {
        this.#unsettled.set(pending.operationId, {
          deadline: pending.deadline,
          resume: pending.resume,
        })
        continue
      }
      // A change sent on a connection Hearth itself closed may have run.
      pending.resume(
        pending.operationId
          ? unknownOutcome(
              "Hearth closed its connection to this Relay before the change finished. Check the result before trying again."
            )
          : relayConnectionFailure(cause.message, cause)
      )
    }
    this.#pending.clear()
    if (this.#unsettled.size > 0) this.#watchUnsettled()
  }

  // Asks the Relay how each unsettled change went, once it's connected, until
  // each one's deadline.
  #watchUnsettled(): void {
    if (this.#settling) return
    this.#settling = true
    forkPromise(
      () =>
        ensuringPromise(
          async () => {
            while (this.#unsettled.size > 0 && !this.#closed) {
              await this.#settleUnsettled()
              if (this.#unsettled.size > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, UNSETTLED_CHANGE_POLL_MS)
                )
              }
            }
          },
          () => {
            this.#settling = false
          }
        ),
      (cause) => {
        reportAppError(cause, { operation: "relay.connection.settle" })
      }
    )
  }

  async #settleUnsettled(): Promise<void> {
    const now = Date.now()
    for (const [operationId, change] of [...this.#unsettled]) {
      if (now >= change.deadline) {
        this.#unsettled.delete(operationId)
        change.resume(
          unknownOutcome(
            "The connection to this Relay dropped before it answered, and it hasn't reported how the change went. Check the result before trying again."
          )
        )
        continue
      }
      if (this.#state.status !== "authenticated") continue
      const lookup = await runAppEffect(
        "relay.operation.lookup",
        this.request("operation.get", { operationId }, 10_000).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(RelayOperationLookupSchema)
          ),
          Effect.option
        )
      )
      if (Option.isNone(lookup)) continue
      const outcome = lookup.value
      if (outcome.status === "running") continue
      this.#unsettled.delete(operationId)
      change.resume(
        outcome.status === "succeeded"
          ? "result" in outcome
            ? Effect.succeed(outcome.result)
            : Effect.fail(
                RelayUnavailableError.make({
                  code: "result_unavailable",
                  message:
                    "The change went through, but its result is no longer available. Refresh to see it.",
                  retryable: false,
                })
              )
          : outcome.status === "failed" &&
              outcome.code === "operation_withdrawn"
            ? relayConnectionFailure(
                "The connection to this Relay dropped before the change ran. It didn't run."
              )
            : outcome.status === "failed"
              ? Effect.fail(
                  RelayUnavailableError.make({
                    code: outcome.code,
                    message: outcome.message,
                    retryable: outcome.retryable,
                  })
                )
              : outcome.status === "unknown"
                ? relayConnectionFailure(
                    "The connection to this Relay dropped before the change reached it. It didn't run."
                  )
                : unknownOutcome(
                    "This Relay restarted while running the change. Check the result before trying again."
                  )
      )
    }
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
    if (
      wasReachable &&
      !isReachable &&
      connections.get(this.#relay.id) === this
    ) {
      noteRelayUpdatesAbsent(this.#relay.id)
    }
    if (
      wasReachable !== isReachable &&
      connections.get(this.#relay.id) === this
    ) {
      publishRealtimeChange({
        relayId: this.#relay.id,
        status: isReachable ? "connected" : "unreachable",
        type: "relay.state",
        updating: isRelayUpdating(this.#relay.id),
      })
    }
    if (becameAuthenticated) {
      // The Relay keeps its own pause. Tell it whether this Hearth holds it
      // on every connect, and again while it reports otherwise, so a pause
      // or resume it missed still arrives.
      this.#pauseFiber?.interruptUnsafe()
      this.#pauseFiber = forkAppEffect(
        "relay.pause.syncOnConnect",
        Effect.gen({ self: this }, function* () {
          // Until Hearth's database answers whether it's paused here.
          while (this.#wantsPaused === null) {
            const loaded = yield* Effect.result(
              promiseEffect(async () => {
                const { listPersistedRelays } =
                  await import("@/lib/relay-registry")
                return (await listPersistedRelays()).find(
                  (relay) => relay.id === this.#relay.id
                )
              })
            )
            if (Result.isSuccess(loaded)) {
              if (!loaded.success) return
              this.#wantsPaused ??= !loaded.success.enabled
            } else {
              yield* Effect.logWarning(
                "Relay pause sync couldn't read Hearth",
                {
                  cause: loaded.failure,
                  relayId: this.#relay.id,
                }
              )
              yield* Effect.sleep(PAUSE_RECHECK_MS)
            }
          }
          yield* this.#tellPause(true)
          while (true) {
            yield* Effect.sleep(PAUSE_RECHECK_MS)
            yield* this.#tellPause(false)
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Relay pause sync after connect failed", {
              cause,
              relayId: this.#relay.id,
            })
          )
        )
      )
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
      // Settles audited changes a Hearth restart left pending: now, once
      // more after the longest change this process could still be awaiting,
      // and again while some are still running on the Relay.
      this.#auditFiber?.interruptUnsafe()
      this.#auditFiber = forkAppEffect(
        "audit.reconcileOnConnect",
        Effect.gen({ self: this }, function* () {
          yield* this.#reconcileAudit()
          for (let pass = 1; pass < AUDIT_RECONCILE_PASSES; pass += 1) {
            yield* Effect.sleep(AUDIT_IN_FLIGHT_MS)
            if ((yield* this.#reconcileAudit()) === 0) return
          }
        })
      )
    }
  }

  // How many pending changes it couldn't settle yet. One Effect throughout,
  // so interrupting it stops the scan and its lookups.
  #reconcileAudit(): Effect.Effect<number, never, Database> {
    return promiseEffect(() => import("@/lib/hearth-audit.server")).pipe(
      Effect.flatMap(({ reconcilePendingRelayChanges }) =>
        this.#state.status === "authenticated"
          ? reconcilePendingRelayChanges(
              this.#relay.id,
              Date.now() - AUDIT_IN_FLIGHT_MS,
              (operationId) =>
                this.request("operation.get", { operationId }, 10_000).pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(RelayOperationLookupSchema)
                  )
                )
            )
          : Effect.succeed(0)
      ),
      Effect.withSpan("audit.reconcile"),
      Effect.catch((cause) =>
        Effect.logWarning("Audit reconciliation after Relay connect failed", {
          cause,
          relayId: this.#relay.id,
        }).pipe(Effect.as(0))
      )
    )
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
              // A failed #openEffect tries to reschedule while this fiber is
              // still registered. Continue only after releasing that guard.
              if (!this.#closed && this.#state.status !== "authenticated") {
                this.#scheduleReconnect()
              }
            }
          })
        )
      )
    )
    this.#reconnectFiber = reconnecting
  }
}

function browserAuthorizationReadiness(): BrowserAuthorizationReadiness {
  let reject: (cause: Error) => void = () => undefined
  let resolve: (issuerGeneration: number) => void = () => undefined
  const promise = new Promise<number>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  // Synchronization starts independently of capability issuance; retain a
  // rejection for future callers without creating an unhandled promise.
  forkPromise(() => promise)
  return { promise, reject, resolve }
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

type AuditWrite = (
  audit: typeof import("@/lib/hearth-audit.server")
) => Effect.Effect<void, unknown, Database>

/**
 * Records a change in Hearth's audit. `started` settles once its row is
 * written, or after `AUDIT_START_WAIT_MS` if the database is slow, so the
 * change goes ahead either way. Its outcome is written after its row, in the
 * background. Audit writes never fail the change they record.
 */
function auditChange(start: AuditWrite): {
  readonly finish: (write: AuditWrite) => void
  readonly started: Promise<void>
} {
  const starting = forkAppEffect("relay.audit.start", auditWrite(start))
  return {
    finish: (write) => {
      forkAppEffect(
        "relay.audit.finish",
        Fiber.await(starting).pipe(Effect.andThen(auditWrite(write)))
      )
    },
    started: runAppEffect(
      "relay.audit.wait",
      Fiber.await(starting).pipe(
        Effect.timeoutOption(AUDIT_START_WAIT_MS),
        Effect.asVoid
      )
    ),
  }
}

function auditWrite(write: AuditWrite): Effect.Effect<void, never, Database> {
  return promiseEffect(() => import("@/lib/hearth-audit.server")).pipe(
    Effect.flatMap(write),
    Effect.catch((cause) =>
      Effect.sync(() => {
        reportAppError(cause, { operation: "relay.audit" })
      })
    )
  )
}

function auditFailure(error: unknown): {
  readonly errorCode?: string
  readonly outcome: "failed" | "not_run" | "succeeded" | "unknown"
} {
  if (!(error instanceof RelayUnavailableError)) return { outcome: "failed" }
  if (error.outcome === "unknown") {
    return {
      ...(error.code ? { errorCode: error.code } : {}),
      outcome: "unknown",
    }
  }
  // It went through; only its reply was lost.
  if (error.code === "result_unavailable") {
    return { errorCode: error.code, outcome: "succeeded" }
  }
  // An error the Relay sent back carries a code. One without came from the
  // connection, before the Relay had the change.
  if (
    !error.code ||
    error.code === "forbidden" ||
    error.code === "operation_withdrawn" ||
    error.code === "relay_paused" ||
    error.code === "too_many_requests"
  ) {
    return {
      ...(error.code ? { errorCode: error.code } : {}),
      outcome: "not_run",
    }
  }
  return { errorCode: error.code, outcome: "failed" }
}

interface PendingRequest {
  readonly deadline: number
  readonly operationId: string | undefined
  readonly resume: (
    effect: Effect.Effect<unknown, RelayUnavailableError>
  ) => void
}

interface UnsettledChange {
  readonly deadline: number
  readonly resume: PendingRequest["resume"]
}

const UNSETTLED_CHANGE_POLL_MS = 1_000
// Past the longest change deadline, a pending audit row has no request left
// waiting for it in any Hearth process.
const AUDIT_IN_FLIGHT_MS = relayControlDeadlineMs("relay.update.apply") + 60_000
const AUDIT_RECONCILE_PASSES = 6
// How often a connection checks that the Relay has the pause it was told.
const PAUSE_RECHECK_MS = 30_000
const AUDIT_START_WAIT_MS = 2_000

function unknownOutcome(
  message: string
): Effect.Effect<never, RelayUnavailableError> {
  return Effect.fail(
    RelayUnavailableError.make({
      message,
      outcome: "unknown",
      retryable: false,
    })
  )
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
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text),
    Schema.decodeUnknownOption(RelayControlServerMessageSchema)
  )

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
