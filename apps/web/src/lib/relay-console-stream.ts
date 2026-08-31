import {
  relayBrowserConsoleProtocol,
  relayBrowserProofTranscript,
  relayBrowserConsoleProtocols,
  relayBrowserProtocol,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import type { RelayConsoleStreamEvent } from "@workspace/contracts"
import { Effect, Result, Stream } from "effect"

import { recoverPromise } from "@/effect/promise"
import {
  startConsoleTimingSpan,
  withConsoleTimingSpan,
} from "@/lib/console-performance"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import { issueConsoleCapability } from "@/server/relay-capability"

const AUTHENTICATION_TIMEOUT_MS = 10_000

export type RelayConsoleTransport = "direct" | "hearth"

export type KilnConsoleStreamEvent =
  | RelayConsoleStreamEvent
  | {
      message: string | null
      transport: RelayConsoleTransport
      type: "transport"
    }

export class RelayConsoleConnectionError extends Error {
  readonly code:
    | "browser_offline"
    | "console_unavailable"
    | "direct_secure_channel_failed"
    | "hearth_proxy_failed"

  constructor(
    code: RelayConsoleConnectionError["code"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "RelayConsoleConnectionError"
    this.code = code
  }
}

export function openRelayConsoleStream(
  relayId: string,
  instanceId: string,
  signal: AbortSignal,
  timing?: ConsoleLoadTiming
): AsyncGenerator<KilnConsoleStreamEvent> {
  if (!navigator.onLine) {
    const offline = Stream.toAsyncIterable(
      Stream.fail(
        new RelayConsoleConnectionError(
          "browser_offline",
          "You're offline. Reconnect to the internet to resume the console."
        )
      )
    )
    return (async function* () {
      yield* offline
    })()
  }

  const direct = Stream.fromAsyncIterable(
    openDirectRelayConsoleStream(relayId, instanceId, signal, timing),
    asError
  )
  const stream = Stream.toAsyncIterable(
    direct.pipe(
      Stream.catch((directCause) => {
        if (signal.aborted) return Stream.fail(asError(directCause))
        const directFailure = asError(directCause)
        return Stream.fromAsyncIterable(
          openHearthConsoleStream(
            relayId,
            instanceId,
            signal,
            directFallbackMessage(directFailure),
            timing
          ),
          asError
        ).pipe(
          Stream.catch((cause) =>
            Stream.fail(
              signal.aborted
                ? asError(cause)
                : new RelayConsoleConnectionError(
                    "hearth_proxy_failed",
                    "Hearth can reach this Relay, but neither the secure direct stream nor the Hearth fallback could read the console.",
                    { cause }
                  )
            )
          )
        )
      })
    )
  )
  return (async function* () {
    yield* stream
  })()
}

async function* openDirectRelayConsoleStream(
  relayId: string,
  instanceId: string,
  signal: AbortSignal,
  timing?: ConsoleLoadTiming
): AsyncGenerator<KilnConsoleStreamEvent> {
  const { keys, publicKeyJwk } = await withConsoleTimingSpan(
    timing,
    "Generate console session key",
    "crypto.console.key",
    async () => {
      const keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"]
      )
      return {
        keys,
        publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
      }
    }
  )
  const capability = await withConsoleTimingSpan(
    timing,
    "Issue console capability",
    "http.console.capability",
    () =>
      issueConsoleCapability({
        data: {
          instanceId,
          publicKeyJwk: {
            crv: "P-256",
            kty: "EC",
            x: requiredJwkCoordinate(publicKeyJwk.x),
            y: requiredJwkCoordinate(publicKeyJwk.y),
          },
          relayId,
        },
      })
  )
  if (capability.proxyMode === "hearth") {
    throw new RelayConsoleConnectionError(
      "direct_secure_channel_failed",
      "This Relay is configured to stream through Hearth."
    )
  }
  const relayOrigin = new URL(capability.browserOrigin)
  relayOrigin.protocol = relayOrigin.protocol === "https:" ? "wss:" : "ws:"
  relayOrigin.pathname = "/v1/browser"
  const socket = new WebSocket(relayOrigin, [...relayBrowserConsoleProtocols])
  const inbox = createSocketInbox(socket, signal)

  yield* managedAsyncIterable(
    (async function* () {
      const challenge = await withConsoleTimingSpan(
        timing,
        "Open Relay WebSocket",
        "websocket.console.connect",
        () => nextAuthenticationMessage(inbox, "challenge")
      )
      if (
        challenge.type !== "auth.challenge" ||
        challenge.relayId !== relayId ||
        typeof challenge.sessionId !== "string" ||
        typeof challenge.nonce !== "string" ||
        typeof challenge.expiresAt !== "number" ||
        challenge.expiresAt <= Date.now()
      ) {
        throw new Error("Relay returned an invalid browser challenge")
      }
      const expiresAt = challenge.expiresAt
      const nonce = challenge.nonce
      const sessionId = challenge.sessionId
      await withConsoleTimingSpan(
        timing,
        "Authenticate Relay WebSocket",
        "websocket.console.authenticate",
        async () => {
          const proof = await crypto.subtle.sign(
            { hash: "SHA-256", name: "ECDSA" },
            keys.privateKey,
            new TextEncoder().encode(
              relayBrowserProofTranscript(
                {
                  capabilityId: capabilityId(capability.capability),
                  expiresAt,
                  nonce,
                  relayId,
                  sessionId,
                },
                socket.protocol === relayBrowserConsoleProtocol
                  ? relayBrowserConsoleProtocol
                  : relayBrowserProtocol
              )
            )
          )
          socket.send(
            JSON.stringify({
              capability: capability.capability,
              publicKeyJwk: {
                crv: "P-256",
                kty: "EC",
                x: requiredJwkCoordinate(publicKeyJwk.x),
                y: requiredJwkCoordinate(publicKeyJwk.y),
              },
              signature: bytesToBase64Url(new Uint8Array(proof)),
              type: "auth",
              v: 1,
            })
          )
          const ready = await nextAuthenticationMessage(inbox, "confirmation")
          if (ready.type !== "auth.ready" || ready.instanceId !== instanceId) {
            throw new Error("Relay browser authentication failed")
          }
        }
      )
      socket.send(
        JSON.stringify({ instanceId, type: "console.subscribe", v: 1 })
      )
      yield { message: null, transport: "direct", type: "transport" } as const

      const initialSnapshotSpan = startConsoleTimingSpan(
        timing,
        "Receive initial Relay console snapshot",
        "websocket.console.snapshot"
      )
      let initialSnapshotPending = true
      yield* managedAsyncIterable(
        (async function* () {
          // Console frames are a single ordered stream; concurrent reads could reorder them.
          for (;;) {
            // This is an ordered, unbounded socket stream; parallel reads would reorder frames.
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const message = await inbox.next()
            const event = relayConsoleStreamEventSchema.parse(message)
            if (
              initialSnapshotPending &&
              (event.type === "reset" || event.type === "ready")
            ) {
              initialSnapshotPending = false
              initialSnapshotSpan.setAttribute(
                "kiln.console.event_type",
                event.type
              )
              if (event.type === "reset") {
                initialSnapshotSpan.setAttribute(
                  "kiln.console.line_count",
                  event.lines.length
                )
              }
              initialSnapshotSpan.end()
            }
            yield event
          }
        })(),
        () => {
          if (!initialSnapshotPending) return
          initialSnapshotSpan.setAttribute("kiln.console.result", "cancelled")
          initialSnapshotSpan.end()
        }
      )
    })(),
    () => {
      inbox.close()
      socket.close(1000, "Console view closed")
    }
  )
}

async function nextAuthenticationMessage(
  inbox: { next: () => Promise<Record<string, unknown>> },
  stage: string
): Promise<Record<string, unknown>> {
  let timer: number | undefined
  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        Promise.race([
          inbox.next(),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(
              () =>
                reject(new Error(`Relay authentication ${stage} timed out`)),
              AUTHENTICATION_TIMEOUT_MS
            )
          }),
        ]),
      catch: asError,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (timer !== undefined) window.clearTimeout(timer)
        })
      )
    )
  )
}

async function* openHearthConsoleStream(
  relayId: string,
  instanceId: string,
  signal: AbortSignal,
  fallbackMessage: string,
  timing?: ConsoleLoadTiming
): AsyncGenerator<KilnConsoleStreamEvent> {
  const response = await withConsoleTimingSpan(
    timing,
    "Open Hearth console stream",
    "http.console.fallback",
    () =>
      fetch(
        `/api/console/${encodeURIComponent(instanceId)}?relayId=${encodeURIComponent(relayId)}`,
        { cache: "no-store", signal }
      )
  )
  if (!response.ok || !response.body) {
    const problem = (await recoverPromise(
      () => response.json(),
      () => null
    )) as {
      error?: unknown
    } | null
    throw new Error(
      typeof problem?.error === "string"
        ? problem.error
        : `Hearth console proxy returned HTTP ${response.status}`
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  yield* managedAsyncIterable(
    (async function* () {
      yield { message: fallbackMessage, transport: "hearth", type: "transport" }
      const initialSnapshotSpan = startConsoleTimingSpan(
        timing,
        "Receive initial Hearth console snapshot",
        "http.console.snapshot"
      )
      let initialSnapshotPending = true
      yield* managedAsyncIterable(
        (async function* () {
          for (;;) {
            // NDJSON chunks can split records at arbitrary byte boundaries.
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const result = await reader.read()
            buffered += decoder.decode(result.value, { stream: !result.done })
            const lines = buffered.split("\n")
            buffered = lines.pop() ?? ""
            for (const line of lines) {
              if (!line) continue
              const value = JSON.parse(line) as unknown
              if (
                value &&
                typeof value === "object" &&
                "type" in value &&
                value.type === "proxy.error"
              ) {
                const message =
                  "message" in value && typeof value.message === "string"
                    ? value.message
                    : "Hearth console proxy was interrupted"
                throw new Error(message)
              }
              const event = relayConsoleStreamEventSchema.parse(value)
              if (
                initialSnapshotPending &&
                (event.type === "reset" || event.type === "ready")
              ) {
                initialSnapshotPending = false
                initialSnapshotSpan.setAttribute(
                  "kiln.console.event_type",
                  event.type
                )
                if (event.type === "reset") {
                  initialSnapshotSpan.setAttribute(
                    "kiln.console.line_count",
                    event.lines.length
                  )
                }
                initialSnapshotSpan.end()
              }
              yield event
            }
            if (result.done) break
          }
          if (buffered.trim()) {
            yield relayConsoleStreamEventSchema.parse(JSON.parse(buffered))
          }
        })(),
        () => {
          if (!initialSnapshotPending) return
          initialSnapshotSpan.setAttribute("kiln.console.result", "cancelled")
          initialSnapshotSpan.end()
        }
      )
    })(),
    () => reader.cancel()
  )
}

function directFallbackMessage(cause: Error): string {
  return cause instanceof RelayConsoleConnectionError &&
    cause.code === "direct_secure_channel_failed"
    ? "Secure direct connection unavailable. Streaming through Hearth."
    : "Direct Relay stream interrupted. Streaming through Hearth."
}

export function createSocketInbox(socket: WebSocket, signal: AbortSignal) {
  const messages: Array<Record<string, unknown>> = []
  let terminalError: Error | null = null
  const waiters: Array<{
    reject: (cause: Error) => void
    resolve: (value: Record<string, unknown>) => void
  }> = []
  const fail = (cause: Error) => {
    terminalError ??= cause
    for (const waiter of waiters.splice(0)) waiter.reject(cause)
  }
  socket.addEventListener("message", (event) => {
    Result.try(() => {
      const value = JSON.parse(String(event.data)) as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Relay returned an invalid browser message")
      }
      const message = Object.fromEntries(Object.entries(value))
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(message)
      else messages.push(message)
    }).pipe(
      Result.match({
        onFailure: (cause) => fail(asError(cause)),
        onSuccess: () => undefined,
      })
    )
  })
  socket.addEventListener("error", () =>
    fail(new Error("Unable to connect to Relay"))
  )
  socket.addEventListener("close", (event) =>
    fail(
      new Error(
        event.reason || `Relay browser connection closed (${event.code})`
      )
    )
  )
  const abort = () => {
    fail(new Error("Console stream was cancelled"))
    socket.close(1000, "Console stream cancelled")
  }
  signal.addEventListener("abort", abort, { once: true })
  return {
    close: () => signal.removeEventListener("abort", abort),
    next: () => {
      const message = messages.shift()
      if (message) return Promise.resolve(message)
      if (terminalError) return Promise.reject(terminalError)
      return new Promise<Record<string, unknown>>((resolve, reject) =>
        waiters.push({ reject, resolve })
      )
    },
  }
}

function capabilityId(capability: string): string {
  const encoded = capability.split(".", 1)[0]
  if (!encoded) throw new Error("Hearth returned an invalid Relay capability")
  const value = JSON.parse(atobBase64Url(encoded)) as unknown
  if (!value || typeof value !== "object" || !("capabilityId" in value)) {
    throw new Error("Hearth returned an invalid Relay capability")
  }
  const id = Object.fromEntries(Object.entries(value)).capabilityId
  if (typeof id !== "string") {
    throw new Error("Hearth returned an invalid Relay capability")
  }
  return id
}

function requiredJwkCoordinate(value: string | undefined): string {
  if (!value) throw new Error("Browser could not create a console session key")
  return value
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function atobBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Relay browser connection failed")
}

function managedAsyncIterable<A>(
  iterable: AsyncIterable<A>,
  cleanup: () => void | Promise<unknown>
): AsyncIterable<A> {
  return Stream.toAsyncIterable(
    Stream.fromAsyncIterable(iterable, asError).pipe(
      Stream.ensuring(
        Effect.tryPromise({
          try: async () => cleanup(),
          catch: asError,
        }).pipe(Effect.ignore)
      )
    )
  )
}
