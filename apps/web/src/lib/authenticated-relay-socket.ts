import {
  relayBrowserConsoleProtocol,
  relayBrowserMaxFrameBytes,
  relayBrowserProofTranscript,
  relayBrowserProtocol,
} from "@workspace/contracts"
import * as Sentry from "@sentry/tanstackstart-react"
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Queue,
  Result,
  Schedule,
  Stream,
} from "effect"

import type { RelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import type { RelayConsoleOperation } from "@/lib/relay-console-operations"

const AUTHENTICATION_TIMEOUT_MS = 10_000
const CONSOLE_MESSAGES_MAX = 512
const CONSOLE_BYTES_MAX = 4 * 1024 * 1024
const CONTROL_MESSAGES_MAX = 64
const PENDING_REQUESTS_MAX = 32
const REQUEST_TIMEOUT_MS = 8_000
const RENEW_RECONNECT_REASON = "Relay lease renewal needs reconnect"

export class RelayBrowserReconnectError extends Error {}

// Retry only an ambiguous renewal; normal connectivity failures retain the
// feature fallback, and a replaced owner must never reconnect and evict its heir.
export const relayBrowserReconnectSchedule = Schedule.spaced(250).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 2 }),
  Schedule.while(({ input }) =>
    Effect.succeed(input instanceof RelayBrowserReconnectError)
  )
)

export interface OpenRelayBrowserSocket {
  challenge: {
    expiresAt: number
    nonce: string
    sessionId: string
  }
  inbox: RelayBrowserSocketInbox
  socket: WebSocket
}

export interface RelayBrowserSocketInbox {
  messages: Queue.Dequeue<
    { bytes: number; value: Record<string, unknown> },
    Error
  >
  request: (
    socket: WebSocket,
    instanceId: string,
    operation: RelayConsoleOperation,
    payload: Record<string, unknown>
  ) => Promise<unknown>
  stream: Stream.Stream<Record<string, unknown>, Error>
  take: Effect.Effect<Record<string, unknown>, Error>
  waitFor: (
    type: string,
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>
}

export function openAuthenticatedRelaySocket(input: {
  browserOrigin: string
  capability: string
  channel: "console" | "resources"
  closeReason?: string
  credentials: RelayBrowserCredentials
  instanceId: string
  protocols: string | ReadonlyArray<string>
  relayId: string
}) {
  return Effect.gen(function* () {
    const opened = yield* openRelayBrowserSocket(input)
    const ready = yield* authenticateRelayBrowserSocket(opened, input)
    return { ...opened, ready }
  })
}

export function maintainRelayBrowserLease(
  opened: OpenRelayBrowserSocket,
  ready: Record<string, unknown>,
  input: {
    credentials: RelayBrowserCredentials
    channel: "console" | "resources"
    issue: () => Promise<{
      capability: string
      expiresAt: number
      version: 1 | 2
    }>
    relayId: string
    write: boolean
  }
) {
  return Effect.gen(function* () {
    const initial = renewalState(ready)
    if (!initial)
      return yield* Effect.fail(
        new Error("Relay did not provide renewal state")
      )
    let current = initial
    let retryCount = 0
    let renewalSent = false
    // One scoped worker serializes scheduled and permission-triggered renewals.
    // A change arriving during issuance is retained for the next iteration.
    const wake = yield* Queue.sliding<void>(1)
    yield* Effect.addFinalizer(() => Queue.shutdown(wake))
    const renew = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Sentry.startInactiveSpan({
            name: "Renew Relay browser lease",
            op: "websocket.relay.renew",
            attributes: {
              "kiln.channel": input.channel,
              "kiln.retry_count": retryCount,
            },
          })
        ),
        (span, exit) =>
          Effect.sync(() => {
            const result = Exit.isSuccess(exit)
              ? "ok"
              : Exit.hasInterrupts(exit)
                ? "cancelled"
                : "error"
            span.setAttribute("kiln.result", result)
            if (result === "error")
              span.setStatus({ code: 2, message: "renewal_failed" })
            span.end()
          })
      )
      const capability = yield* Effect.tryPromise({
        try: input.issue,
        catch: (cause) => cause,
      }).pipe(Effect.timeout(AUTHENTICATION_TIMEOUT_MS))
      if (capability.version !== 2)
        return yield* Effect.fail(
          new Error("Hearth downgraded an active Relay lease")
        )
      const proof = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.sign(
            { hash: "SHA-256", name: "ECDSA" },
            input.credentials.keys.privateKey,
            new TextEncoder().encode(
              relayBrowserProofTranscript(
                {
                  capabilityId: capabilityId(capability.capability),
                  expiresAt: current.renewalNonceExpiresAt,
                  nonce: current.renewalNonce,
                  relayId: input.relayId,
                  sessionId: current.sessionId,
                },
                opened.socket.protocol === relayBrowserConsoleProtocol
                  ? relayBrowserConsoleProtocol
                  : relayBrowserProtocol
              )
            )
          ),
        catch: asError,
      })
      const acknowledgement = yield* Effect.tryPromise({
        try: (signal) => {
          const response = opened.inbox.waitFor("auth.renewed", signal)
          // Once sent, Relay may have consumed the nonce even if the ack is lost.
          renewalSent = true
          opened.socket.send(
            JSON.stringify({
              capability: capability.capability,
              signature: bytesToBase64Url(new Uint8Array(proof)),
              type: "auth.renew",
              v: 1,
            })
          )
          return response
        },
        catch: asError,
      })
      const next = renewalState(acknowledgement, current.sessionId)
      if (!next)
        return yield* Effect.fail(
          new Error("Relay returned invalid renewal state")
        )
      current = next
    }).pipe(Effect.scoped)
    yield* Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis
        const remaining = current.expiresAt - now
        if (remaining <= 0) {
          opened.socket.close(4403, "Relay lease renewal expired")
          return
        }
        const delay =
          retryCount === 0
            ? Math.max(0, remaining - (input.write ? 10_000 : 20_000))
            : Math.min(
                remaining,
                Math.min(5_000, 400 * 2 ** Math.min(retryCount - 1, 5)) *
                  (0.8 + Math.random() * 0.4)
              )
        yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(delay))
        renewalSent = false
        const outcome = yield* renew.pipe(Effect.result)
        if (Result.isFailure(outcome)) {
          if (renewalSent) {
            opened.socket.close(4012, RENEW_RECONNECT_REASON)
            return
          }
          if (isAuthorizationFailure(outcome.failure)) {
            opened.socket.close(4403, "Relay browser authorization changed")
            return
          }
          retryCount += 1
        } else {
          retryCount = 0
        }
      }
    }).pipe(Effect.forkScoped)
    return {
      renewNow: () => {
        Queue.offerUnsafe(wake, undefined)
      },
    }
  })
}

export function openRelayBrowserSocket(input: {
  browserOrigin: string
  channel: "console" | "resources"
  closeReason?: string
  protocols: string | ReadonlyArray<string>
  relayId: string
}) {
  return Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => relayBrowserEndpoint(input.browserOrigin),
      catch: asError,
    })
    const socket = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new WebSocket(
            endpoint,
            typeof input.protocols === "string"
              ? input.protocols
              : [...input.protocols]
          ),
        catch: asError,
      }),
      (socket) =>
        Effect.sync(() =>
          socket.close(
            1000,
            input.closeReason ?? "Relay browser session closed"
          )
        )
    )
    const inbox = yield* createRelayBrowserSocketInbox(socket, input.channel)
    const challenge = yield* authenticationMessage(inbox, "challenge")
    if (
      challenge.type !== "auth.challenge" ||
      challenge.relayId !== input.relayId ||
      typeof challenge.sessionId !== "string" ||
      typeof challenge.nonce !== "string" ||
      typeof challenge.expiresAt !== "number" ||
      challenge.expiresAt <= Date.now()
    ) {
      socket.close(4400, "Invalid Relay challenge")
      return yield* Effect.fail(
        new Error("Relay returned an invalid browser challenge")
      )
    }
    return {
      challenge: {
        expiresAt: challenge.expiresAt,
        nonce: challenge.nonce,
        sessionId: challenge.sessionId,
      },
      inbox,
      socket,
    } satisfies OpenRelayBrowserSocket
  })
}

export function authenticateRelayBrowserSocket(
  opened: OpenRelayBrowserSocket,
  input: {
    capability: string
    channel: "console" | "resources"
    credentials: RelayBrowserCredentials
    instanceId: string
    relayId: string
  }
) {
  return Effect.gen(function* () {
    const proof = yield* Effect.tryPromise({
      try: () =>
        Sentry.startSpan(
          {
            name: "Sign Relay browser proof",
            op: "crypto.relay.proof",
            attributes: { "kiln.channel": input.channel },
          },
          () =>
            crypto.subtle.sign(
              { hash: "SHA-256", name: "ECDSA" },
              input.credentials.keys.privateKey,
              new TextEncoder().encode(
                relayBrowserProofTranscript(
                  {
                    capabilityId: capabilityId(input.capability),
                    expiresAt: opened.challenge.expiresAt,
                    nonce: opened.challenge.nonce,
                    relayId: input.relayId,
                    sessionId: opened.challenge.sessionId,
                  },
                  opened.socket.protocol === relayBrowserConsoleProtocol
                    ? relayBrowserConsoleProtocol
                    : relayBrowserProtocol
                )
              )
            )
        ),
      catch: asError,
    })
    opened.socket.send(
      JSON.stringify({
        capability: input.capability,
        publicKeyJwk: input.credentials.publicKeyJwk,
        signature: bytesToBase64Url(new Uint8Array(proof)),
        type: "auth",
        v: 1,
      })
    )
    const ready = yield* authenticationMessage(opened.inbox, "confirmation")
    if (ready.type !== "auth.ready" || ready.instanceId !== input.instanceId) {
      opened.socket.close(4401, "Relay authentication failed")
      return yield* Effect.fail(
        new Error("Relay browser authentication failed")
      )
    }
    return ready
  })
}

export function relayBrowserEndpoint(browserOrigin: string): URL {
  const origin = new URL(browserOrigin)
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:"
  origin.pathname = "/v1/browser"
  return origin
}

export function createRelayBrowserSocketInbox(
  socket: WebSocket,
  channel: "console" | "resources"
) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const messages = yield* Queue.bounded<
        { bytes: number; value: Record<string, unknown> },
        Error
      >(channel === "console" ? CONSOLE_MESSAGES_MAX : CONTROL_MESSAGES_MAX)
      let queuedBytes = 0
      let terminal = false
      let pendingResource: {
        bytes: number
        value: Record<string, unknown>
      } | null = null
      const pending = new Map<
        string,
        {
          reject: (cause: Error) => void
          resolve: (value: unknown) => void
          timer: ReturnType<typeof setTimeout>
        }
      >()
      const controlWaiters = new Map<
        string,
        Array<{
          reject: (cause: Error) => void
          resolve: (message: Record<string, unknown>) => void
          timer: ReturnType<typeof setTimeout>
        }>
      >()
      const fail = (cause: Error) => {
        if (terminal) return
        terminal = true
        for (const request of pending.values()) {
          globalThis.clearTimeout(request.timer)
          request.reject(cause)
        }
        pending.clear()
        for (const waiters of controlWaiters.values()) {
          for (const waiter of waiters) {
            globalThis.clearTimeout(waiter.timer)
            waiter.reject(cause)
          }
        }
        controlWaiters.clear()
        Queue.failCauseUnsafe(messages, Cause.fail(cause))
      }
      const onMessage = (event: MessageEvent) => {
        if (terminal) return
        Result.try(() => {
          const serialized = String(event.data)
          const bytes = new TextEncoder().encode(serialized).byteLength
          if (bytes > relayBrowserMaxFrameBytes) {
            throw new Error("Relay browser frame exceeded the size limit")
          }
          const value = JSON.parse(serialized) as unknown
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Relay returned an invalid browser message")
          }
          const message = Object.fromEntries(Object.entries(value))
          if (typeof message.type === "string") {
            const waiters = controlWaiters.get(message.type)
            const waiter = waiters?.shift()
            if (waiter) {
              globalThis.clearTimeout(waiter.timer)
              waiter.resolve(message)
              if (waiters?.length === 0) controlWaiters.delete(message.type)
              return
            }
            // Renewal acknowledgements are control-only. A timed-out/aborted
            // waiter must not leak a late acknowledgement into a feature codec.
            if (message.type === "auth.renewed") return
          }
          const requestId = message.requestId
          if (
            typeof requestId === "string" &&
            (message.type === "operation.result" ||
              message.type === "operation.error")
          ) {
            const request = pending.get(requestId)
            if (!request) return
            pending.delete(requestId)
            globalThis.clearTimeout(request.timer)
            if (message.type === "operation.result") {
              request.resolve(message.payload)
            } else {
              request.reject(
                new Error(
                  typeof message.message === "string"
                    ? message.message
                    : "Relay operation failed"
                )
              )
            }
            return
          }
          if (channel === "resources" && message.type === "resource") {
            if (pendingResource) {
              // Retain the first authoritative history and all control frames.
              // Replacing the whole queue can discard auth.ready during setup.
              const previousHistory = pendingResource.value.history
              if (
                Array.isArray(previousHistory) &&
                previousHistory.length > 0 &&
                Array.isArray(message.history) &&
                message.history.length === 0
              ) {
                message.history = previousHistory
              }
              const replacementBytes = new TextEncoder().encode(
                JSON.stringify(message)
              ).byteLength
              queuedBytes += replacementBytes - pendingResource.bytes
              if (queuedBytes > CONSOLE_BYTES_MAX) {
                socket.close(4013, "resources consumer is too slow")
                throw new Error("Relay resource queue exceeded its limit")
              }
              pendingResource.bytes = replacementBytes
              pendingResource.value = message
              return
            }
          }
          const queued = { bytes, value: message }
          if (
            queuedBytes + bytes > CONSOLE_BYTES_MAX ||
            !Queue.offerUnsafe(messages, queued)
          ) {
            socket.close(4013, `${channel} consumer is too slow`)
            throw new Error(`Relay ${channel} queue exceeded its limit`)
          }
          queuedBytes += bytes
          if (channel === "resources" && message.type === "resource")
            pendingResource = queued
        }).pipe(
          Result.match({
            onFailure: (cause) => fail(asError(cause)),
            onSuccess: () => undefined,
          })
        )
      }
      const onError = () => fail(new Error("Unable to connect to Relay"))
      const onClose = (event: CloseEvent) =>
        fail(
          event.code === 4012 && event.reason === RENEW_RECONNECT_REASON
            ? new RelayBrowserReconnectError(event.reason)
            : new Error(
                event.reason ||
                  `Relay browser connection closed (${event.code})`
              )
        )
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)

      const unwrap = (message: {
        bytes: number
        value: Record<string, unknown>
      }) => {
        if (message === pendingResource) pendingResource = null
        queuedBytes = Math.max(0, queuedBytes - message.bytes)
        return message.value
      }
      const take = Queue.take(messages).pipe(Effect.map(unwrap))
      const stream = Stream.fromQueue(messages).pipe(Stream.map(unwrap))
      const request: RelayBrowserSocketInbox["request"] = (
        activeSocket,
        instanceId,
        operation,
        payload
      ) => {
        if (
          terminal ||
          activeSocket.readyState !== WebSocket.OPEN ||
          pending.size >= PENDING_REQUESTS_MAX
        ) {
          return Promise.reject(
            new Error("Relay console is busy or unavailable")
          )
        }
        const requestId = crypto.randomUUID()
        return new Promise((resolve, reject) => {
          const timer = globalThis.setTimeout(() => {
            pending.delete(requestId)
            reject(new Error("Relay console operation timed out"))
          }, REQUEST_TIMEOUT_MS)
          pending.set(requestId, { reject, resolve, timer })
          activeSocket.send(
            JSON.stringify({
              ...payload,
              instanceId,
              requestId,
              type: operation,
              v: 1,
            })
          )
        })
      }
      const waitFor = (
        type: string,
        signal?: AbortSignal
      ): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          if (terminal || signal?.aborted) {
            reject(new Error("Relay browser session was cancelled"))
            return
          }
          const cleanup = () => {
            globalThis.clearTimeout(timer)
            signal?.removeEventListener("abort", onAbort)
          }
          const resolveWaiter = (message: Record<string, unknown>) => {
            cleanup()
            resolve(message)
          }
          const rejectWaiter = (cause: Error) => {
            cleanup()
            reject(cause)
          }
          const remove = () => {
            const waiters = controlWaiters.get(type)
            const index =
              waiters?.findIndex(
                (candidate) => candidate.resolve === resolveWaiter
              ) ?? -1
            if (waiters && index >= 0) waiters.splice(index, 1)
            if (waiters?.length === 0) controlWaiters.delete(type)
          }
          const onAbort = () => {
            remove()
            rejectWaiter(new Error("Relay browser session was cancelled"))
          }
          const timer = globalThis.setTimeout(() => {
            remove()
            rejectWaiter(new Error(`Relay ${type} response timed out`))
          }, AUTHENTICATION_TIMEOUT_MS)
          const waiters = controlWaiters.get(type) ?? []
          waiters.push({ reject: rejectWaiter, resolve: resolveWaiter, timer })
          controlWaiters.set(type, waiters)
          signal?.addEventListener("abort", onAbort, { once: true })
        })
      return {
        messages,
        onClose,
        onError,
        onMessage,
        request,
        shutdown: () => fail(new Error("Relay browser session was cancelled")),
        stream,
        take,
        waitFor,
      }
    }),
    ({ onClose, onError, onMessage, shutdown }) =>
      Effect.sync(() => {
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
        shutdown()
      })
  )
}

function authenticationMessage(
  inbox: RelayBrowserSocketInbox,
  stage: string
): Effect.Effect<Record<string, unknown>, Error> {
  return inbox.take.pipe(
    Effect.timeout(`${AUTHENTICATION_TIMEOUT_MS} millis`),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error(`Relay authentication ${stage} timed out`))
    )
  )
}

function capabilityId(capability: string): string {
  const encoded = capability.split(".", 1)[0]
  if (!encoded) throw new Error("Hearth returned an invalid Relay capability")
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/")
  const value = JSON.parse(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  ) as unknown
  if (!value || typeof value !== "object" || !("capabilityId" in value)) {
    throw new Error("Hearth returned an invalid Relay capability")
  }
  const id = Object.fromEntries(Object.entries(value)).capabilityId
  if (typeof id !== "string") {
    throw new Error("Hearth returned an invalid Relay capability")
  }
  return id
}

function renewalState(
  value: Record<string, unknown>,
  sessionIdFallback?: string
): {
  expiresAt: number
  renewalNonce: string
  renewalNonceExpiresAt: number
  sessionId: string
} | null {
  return typeof value.expiresAt === "number" &&
    typeof value.renewalNonce === "string" &&
    typeof value.renewalNonceExpiresAt === "number" &&
    (typeof value.sessionId === "string" || sessionIdFallback !== undefined)
    ? {
        expiresAt: value.expiresAt,
        renewalNonce: value.renewalNonce,
        renewalNonceExpiresAt: value.renewalNonceExpiresAt,
        sessionId:
          typeof value.sessionId === "string"
            ? value.sessionId
            : sessionIdFallback!,
      }
    : null
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Relay browser connection failed")
}

function isAuthorizationFailure(cause: unknown): boolean {
  if (
    cause &&
    typeof cause === "object" &&
    "_tag" in cause &&
    cause._tag === "PermissionDeniedError"
  ) {
    return true
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return /authorization|authori[sz]ed|forbidden|permission|unauthorized|denied|\b40[13]\b/iu.test(
    message
  )
}
