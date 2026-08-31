import {
  relayBrowserConsoleProtocol,
  relayBrowserProofTranscript,
  relayBrowserConsoleProtocols,
  relayBrowserProtocol,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import type { RelayConsoleStreamEvent } from "@workspace/contracts"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Queue,
  Result,
  Scope,
  Stream,
} from "effect"

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
  browserOrigin: string | null,
  timing?: ConsoleLoadTiming
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  if (!navigator.onLine) {
    return Stream.fail(
      new RelayConsoleConnectionError(
        "browser_offline",
        "You're offline. Reconnect to the internet to resume the console."
      )
    )
  }

  return openDirectRelayConsoleStream(
    relayId,
    instanceId,
    browserOrigin,
    timing
  ).pipe(
    Stream.catch((directFailure) =>
      openHearthConsoleStream(
        relayId,
        instanceId,
        directFallbackMessage(directFailure),
        timing
      ).pipe(
        Stream.catch((cause) =>
          Stream.fail(
            new RelayConsoleConnectionError(
              "hearth_proxy_failed",
              "Hearth can reach this Relay, but neither the secure direct stream nor the Hearth fallback could read the console.",
              { cause }
            )
          )
        )
      )
    )
  )
}

function openDirectRelayConsoleStream(
  relayId: string,
  instanceId: string,
  browserOrigin: string | null,
  timing?: ConsoleLoadTiming
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const socketAttempt = browserOrigin
        ? yield* forkRelayConsoleSocket(browserOrigin, relayId, timing)
        : null
      const { capability, keys, publicKeyJwk } = yield* issueConsoleSession(
        relayId,
        instanceId,
        timing
      )
      if (capability.proxyMode === "hearth") {
        return yield* Effect.fail(
          new RelayConsoleConnectionError(
            "direct_secure_channel_failed",
            "This Relay is configured to stream through Hearth."
          )
        )
      }
      let relaySocket
      if (!socketAttempt || !browserOrigin) {
        relaySocket = yield* openRelayConsoleSocket(
          capability.browserOrigin,
          relayId,
          timing
        )
      } else if (
        !sameRelayBrowserEndpoint(browserOrigin, capability.browserOrigin)
      ) {
        yield* Scope.close(socketAttempt.scope, Exit.void)
        relaySocket = yield* openRelayConsoleSocket(
          capability.browserOrigin,
          relayId,
          timing
        )
      } else {
        const socketResult = yield* Fiber.join(socketAttempt.fiber)
        if (Result.isFailure(socketResult)) {
          return yield* Effect.fail(socketResult.failure)
        }
        relaySocket = socketResult.success
      }
      const { challenge, inbox, socket } = relaySocket
      const expiresAt = challenge.expiresAt
      const nonce = challenge.nonce
      const sessionId = challenge.sessionId
      yield* withConsoleTimingSpan(
        timing,
        "Authenticate Relay WebSocket",
        "websocket.console.authenticate",
        Effect.gen(function* () {
          const proof = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.sign(
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
              ),
            catch: asError,
          })
          yield* Effect.sync(() => {
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
          })
          const ready = yield* nextAuthenticationMessage(
            inbox.messages,
            "confirmation"
          )
          if (ready.type !== "auth.ready" || ready.instanceId !== instanceId) {
            return yield* Effect.fail(
              new Error("Relay browser authentication failed")
            )
          }
        })
      )
      yield* Effect.sync(() => {
        socket.send(
          JSON.stringify({ instanceId, type: "console.subscribe", v: 1 })
        )
      })

      const events = Stream.fromQueue(inbox.messages).pipe(
        Stream.mapEffect((message) =>
          Effect.try({
            try: () => relayConsoleStreamEventSchema.parse(message),
            catch: asError,
          })
        ),
        traceInitialSnapshot(
          timing,
          "Receive initial Relay console snapshot",
          "websocket.console.snapshot"
        )
      )
      return events.pipe(
        Stream.prepend<KilnConsoleStreamEvent>([
          { message: null, transport: "direct", type: "transport" },
        ])
      )
    })
  )
}

function issueConsoleSession(
  relayId: string,
  instanceId: string,
  timing?: ConsoleLoadTiming
) {
  return Effect.gen(function* () {
    const { keys, publicKeyJwk } = yield* withConsoleTimingSpan(
      timing,
      "Generate console session key",
      "crypto.console.key",
      Effect.tryPromise({
        try: async () => {
          const keys = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["sign", "verify"]
          )
          return {
            keys,
            publicKeyJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
          }
        },
        catch: asError,
      })
    )
    const capability = yield* withConsoleTimingSpan(
      timing,
      "Issue console capability",
      "http.console.capability",
      Effect.tryPromise({
        try: () =>
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
          }),
        catch: asError,
      })
    )
    return { capability, keys, publicKeyJwk }
  })
}

function forkRelayConsoleSocket(
  browserOrigin: string,
  relayId: string,
  timing?: ConsoleLoadTiming
) {
  return Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void)
    )
    const fiber = yield* openRelayConsoleSocket(
      browserOrigin,
      relayId,
      timing
    ).pipe(Effect.result, Scope.provide(scope), Effect.forkIn(scope))
    return { fiber, scope }
  })
}

function openRelayConsoleSocket(
  browserOrigin: string,
  relayId: string,
  timing?: ConsoleLoadTiming
) {
  return Effect.gen(function* () {
    const relayOrigin = yield* Effect.try({
      try: () => relayBrowserEndpoint(browserOrigin),
      catch: asError,
    })
    const socket = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new WebSocket(relayOrigin, [...relayBrowserConsoleProtocols]),
        catch: asError,
      }),
      (socket) =>
        Effect.sync(() => {
          socket.close(1000, "Console view closed")
        })
    )
    const inbox = yield* createSocketInbox(socket)
    const challenge = yield* withConsoleTimingSpan(
      timing,
      "Open Relay WebSocket",
      "websocket.console.connect",
      nextAuthenticationMessage(inbox.messages, "challenge")
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          socket.close(4400, "Relay challenge failed")
        })
      )
    )
    if (
      challenge.type !== "auth.challenge" ||
      challenge.relayId !== relayId ||
      typeof challenge.sessionId !== "string" ||
      typeof challenge.nonce !== "string" ||
      typeof challenge.expiresAt !== "number" ||
      challenge.expiresAt <= Date.now()
    ) {
      yield* Effect.sync(() => {
        socket.close(4400, "Invalid Relay challenge")
      })
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
    }
  })
}

function relayBrowserEndpoint(browserOrigin: string): URL {
  const origin = new URL(browserOrigin)
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:"
  origin.pathname = "/v1/browser"
  return origin
}

function sameRelayBrowserEndpoint(left: string, right: string): boolean {
  const endpoints = Result.try(() => [
    relayBrowserEndpoint(left).href,
    relayBrowserEndpoint(right).href,
  ])
  return (
    Result.isSuccess(endpoints) && endpoints.success[0] === endpoints.success[1]
  )
}

function nextAuthenticationMessage(
  inbox: Queue.Dequeue<Record<string, unknown>, Error>,
  stage: string
): Effect.Effect<Record<string, unknown>, Error> {
  return Queue.take(inbox).pipe(
    Effect.timeout(`${AUTHENTICATION_TIMEOUT_MS} millis`),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new Error(`Relay authentication ${stage} timed out`))
    )
  )
}

function openHearthConsoleStream(
  relayId: string,
  instanceId: string,
  fallbackMessage: string,
  timing?: ConsoleLoadTiming
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const response = yield* withConsoleTimingSpan(
        timing,
        "Open Hearth console stream",
        "http.console.fallback",
        Effect.tryPromise({
          try: (signal) =>
            fetch(
              `/api/console/${encodeURIComponent(instanceId)}?relayId=${encodeURIComponent(relayId)}`,
              { cache: "no-store", signal }
            ),
          catch: asError,
        })
      )
      const body = response.body
      if (!response.ok || !body) {
        const problem = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: asError,
        }).pipe(Effect.catch(() => Effect.succeed(null)))
        return yield* Effect.fail(
          new Error(
            problem &&
              typeof problem === "object" &&
              "error" in problem &&
              typeof problem.error === "string"
              ? problem.error
              : `Hearth console proxy returned HTTP ${response.status}`
          )
        )
      }

      const events = Stream.fromReadableStream({
        evaluate: () => body,
        onError: asError,
      }).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect(parseHearthConsoleEvent),
        traceInitialSnapshot(
          timing,
          "Receive initial Hearth console snapshot",
          "http.console.snapshot"
        )
      )
      return events.pipe(
        Stream.prepend<KilnConsoleStreamEvent>([
          {
            message: fallbackMessage,
            transport: "hearth",
            type: "transport",
          },
        ])
      )
    })
  )
}

function parseHearthConsoleEvent(
  line: string
): Effect.Effect<RelayConsoleStreamEvent, Error> {
  return Effect.try({
    try: () => {
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
      return relayConsoleStreamEventSchema.parse(value)
    },
    catch: asError,
  })
}

function traceInitialSnapshot<TError, TRequirements>(
  timing: ConsoleLoadTiming | undefined,
  name: string,
  op: string
) {
  return (
    stream: Stream.Stream<RelayConsoleStreamEvent, TError, TRequirements>
  ): Stream.Stream<RelayConsoleStreamEvent, TError, TRequirements> =>
    Stream.suspend(() => {
      const span = startConsoleTimingSpan(timing, name, op)
      let pending = true
      return stream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (
              !pending ||
              (event.type !== "reset" && event.type !== "ready")
            ) {
              return
            }
            pending = false
            span.setAttribute("kiln.console.event_type", event.type)
            span.setAttribute("kiln.console.result", "ok")
            if (event.type === "reset") {
              span.setAttribute("kiln.console.line_count", event.lines.length)
            }
            span.end()
          })
        ),
        Stream.ensuring(
          Effect.sync(() => {
            if (!pending) return
            pending = false
            span.setAttribute("kiln.console.result", "cancelled")
            span.end()
          })
        )
      )
    })
}

function directFallbackMessage(cause: Error): string {
  return cause instanceof RelayConsoleConnectionError &&
    cause.code === "direct_secure_channel_failed"
    ? "Secure direct connection unavailable. Streaming through Hearth."
    : "Direct Relay stream interrupted. Streaming through Hearth."
}

export function createSocketInbox(socket: WebSocket) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const messages = yield* Queue.make<Record<string, unknown>, Error>()
      const fail = (cause: Error) => {
        Queue.failCauseUnsafe(messages, Cause.fail(cause))
      }
      const onMessage = (event: MessageEvent) => {
        Result.try(() => {
          const value = JSON.parse(String(event.data)) as unknown
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Relay returned an invalid browser message")
          }
          Queue.offerUnsafe(messages, Object.fromEntries(Object.entries(value)))
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
      return { messages, onClose, onError, onMessage }
    }),
    ({ messages, onClose, onError, onMessage }) =>
      Effect.sync(() => {
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("error", onError)
        socket.removeEventListener("close", onClose)
        Queue.failCauseUnsafe(
          messages,
          Cause.fail(new Error("Console stream was cancelled"))
        )
      })
  )
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
