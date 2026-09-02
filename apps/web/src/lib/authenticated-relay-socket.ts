import {
  relayBrowserConsoleProtocol,
  relayBrowserMaxFrameBytes,
  relayBrowserProofTranscript,
  relayBrowserProtocol,
} from "@workspace/contracts"
import * as Sentry from "@sentry/tanstackstart-react"
import { Cause, Effect, Queue, Result, Stream } from "effect"

import type { RelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import type { RelayConsoleOperation } from "@/lib/relay-console-operations"

const AUTHENTICATION_TIMEOUT_MS = 10_000
const CONSOLE_MESSAGES_MAX = 512
const CONSOLE_BYTES_MAX = 4 * 1024 * 1024
const CONTROL_MESSAGES_MAX = 64
const PENDING_REQUESTS_MAX = 32
const REQUEST_TIMEOUT_MS = 8_000

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
  waitFor: (type: string) => Promise<Record<string, unknown>>
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
  return Effect.acquireRelease(
    Effect.sync(() => {
      let closed = false
      let current = renewalState(ready)
      let renewing: Promise<void> | null = null
      let retryCount = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const schedule = () => {
        if (closed || !current) return
        if (timer) globalThis.clearTimeout(timer)
        const lead = input.write ? 10_000 : 20_000
        timer = globalThis.setTimeout(
          () => void renewNow(),
          Math.max(0, current.expiresAt - Date.now() - lead)
        )
      }
      const renew = async () =>
        Sentry.startSpan(
          {
            name: "Renew Relay browser lease",
            op: "websocket.relay.renew",
            attributes: {
              "kiln.channel": input.channel,
              "kiln.retry_count": retryCount,
            },
          },
          async () => {
            if (!current) throw new Error("Relay did not provide renewal state")
            const capability = await input.issue()
            if (capability.version !== 2) {
              throw new Error("Hearth downgraded an active Relay lease")
            }
            const proof = await crypto.subtle.sign(
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
            )
            const acknowledgement = opened.inbox.waitFor("auth.renewed")
            opened.socket.send(
              JSON.stringify({
                capability: capability.capability,
                signature: bytesToBase64Url(new Uint8Array(proof)),
                type: "auth.renew",
                v: 1,
              })
            )
            current = renewalState(await acknowledgement, current.sessionId)
            if (!current)
              throw new Error("Relay returned invalid renewal state")
            retryCount = 0
            schedule()
          }
        )
      const retryAfterTransientFailure = () => {
        if (closed || !current) return
        retryCount += 1
        const maximumDelay = Math.min(5_000, 400 * 2 ** (retryCount - 1))
        const jitteredDelay = maximumDelay * (0.8 + Math.random() * 0.4)
        const timeUntilExpiry = current.expiresAt - Date.now() - 1_000
        if (timeUntilExpiry <= 0) {
          opened.socket.close(4403, "Relay lease renewal expired")
          return
        }
        timer = globalThis.setTimeout(
          () => void renewNow(),
          Math.min(jitteredDelay, timeUntilExpiry)
        )
      }
      const renewNow = (): Promise<void> => {
        if (closed) return Promise.resolve()
        if (renewing) return renewing
        renewing = Effect.runPromise(
          Effect.tryPromise({ try: renew, catch: (cause) => cause }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                // A denied renewal means Hearth no longer authorizes this
                // lease. Close immediately instead of retaining stale access
                // until the Relay-side expiry timer catches up.
                if (isAuthorizationFailure(cause)) {
                  opened.socket.close(
                    4403,
                    "Relay browser authorization changed"
                  )
                  return
                }
                // Transient failures retain the last authoritative stream and
                // retry with bounded jitter while the lease is still valid.
                retryAfterTransientFailure()
              })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                renewing = null
              })
            )
          )
        )
        return renewing
      }
      schedule()
      return {
        close: () => {
          closed = true
          if (timer) globalThis.clearTimeout(timer)
        },
        renewNow,
      }
    }),
    (lease) => Effect.sync(lease.close)
  )
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
            while (Queue.sizeUnsafe(messages) > 0) Queue.takeUnsafe(messages)
            queuedBytes = 0
          }
          if (
            queuedBytes + bytes > CONSOLE_BYTES_MAX ||
            !Queue.offerUnsafe(messages, { bytes, value: message })
          ) {
            socket.close(1013, `${channel} consumer is too slow`)
            throw new Error(`Relay ${channel} queue exceeded its limit`)
          }
          queuedBytes += bytes
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
          new Error(
            event.reason || `Relay browser connection closed (${event.code})`
          )
        )
      socket.addEventListener("message", onMessage)
      socket.addEventListener("error", onError)
      socket.addEventListener("close", onClose)

      const unwrap = (message: {
        bytes: number
        value: Record<string, unknown>
      }) => {
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
      const waitFor = (type: string): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const timer = globalThis.setTimeout(() => {
            const waiters = controlWaiters.get(type)
            if (waiters) {
              const index = waiters.findIndex(
                (candidate) => candidate.resolve === resolve
              )
              if (index >= 0) waiters.splice(index, 1)
              if (waiters.length === 0) controlWaiters.delete(type)
            }
            reject(new Error(`Relay ${type} response timed out`))
          }, AUTHENTICATION_TIMEOUT_MS)
          const waiters = controlWaiters.get(type) ?? []
          waiters.push({ reject, resolve, timer })
          controlWaiters.set(type, waiters)
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
