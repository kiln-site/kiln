import {
  relayBrowserConsoleProtocols,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import type { RelayConsoleStreamEvent } from "@workspace/contracts"
import { Effect, Exit, Fiber, Result, Scope, Stream } from "effect"

import {
  startConsoleTimingSpan,
  withConsoleTimingSpan,
} from "@/lib/console-performance"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import {
  authenticateRelayBrowserSocket,
  createRelayBrowserSocketInbox,
  maintainRelayBrowserLease,
  openRelayBrowserSocket,
  relayBrowserEndpoint,
} from "@/lib/authenticated-relay-socket"
import { acquireRelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import { registerRelayConsoleOperationClient } from "@/lib/relay-console-operations"

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
  consoleTransport: RelayConsoleTransport | null = null,
  timing?: ConsoleLoadTiming,
  write = false
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  if (!navigator.onLine) {
    return Stream.fail(
      new RelayConsoleConnectionError(
        "browser_offline",
        "You're offline. Reconnect to the internet to resume the console."
      )
    )
  }

  const openHearth = (fallbackMessage: string | null) =>
    openHearthConsoleStream(relayId, instanceId, fallbackMessage, timing).pipe(
      Stream.catch((cause) =>
        Stream.fail(
          new RelayConsoleConnectionError(
            "hearth_proxy_failed",
            fallbackMessage === null
              ? "Hearth can reach this Relay, but its secure console stream could not be opened."
              : "Hearth can reach this Relay, but neither the secure direct stream nor the Hearth fallback could read the console.",
            { cause }
          )
        )
      )
    )

  if (consoleTransport === "hearth") return openHearth(null)

  return openDirectRelayConsoleStream(
    relayId,
    instanceId,
    browserOrigin,
    timing,
    write
  ).pipe(
    Stream.catch((directFailure) =>
      openHearth(directFallbackMessage(directFailure))
    )
  )
}

function openDirectRelayConsoleStream(
  relayId: string,
  instanceId: string,
  browserOrigin: string | null,
  timing?: ConsoleLoadTiming,
  write = false
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const socketAttempt = browserOrigin
        ? yield* forkRelayConsoleSocket(browserOrigin, relayId, timing)
        : null
      const credentialLease = yield* Effect.acquireRelease(
        Effect.sync(() => acquireRelayBrowserCredentials(relayId, instanceId)),
        (lease) => Effect.sync(lease.release)
      )
      const { keys, publicKeyJwk } = yield* Effect.tryPromise({
        try: () => credentialLease.credentials,
        catch: asError,
      })
      const capability = yield* withConsoleTimingSpan(
        timing,
        "Issue console capability",
        "http.console.capability",
        Effect.tryPromise({
          try: () =>
            credentialLease.issue({
              kind: "console",
              optInV2: true,
              write,
            }),
          catch: asError,
        })
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
        if (
          Result.isSuccess(socketResult) &&
          canReuseRelayConsoleSocket(socketResult.success)
        ) {
          relaySocket = socketResult.success
        } else {
          yield* Scope.close(socketAttempt.scope, Exit.void)
          relaySocket = yield* openRelayConsoleSocket(
            capability.browserOrigin,
            relayId,
            timing
          )
        }
      }
      const { inbox, socket } = relaySocket
      const ready = yield* withConsoleTimingSpan(
        timing,
        "Authenticate Relay WebSocket",
        "websocket.console.authenticate",
        authenticateRelayBrowserSocket(relaySocket, {
          capability: capability.capability,
          channel: "console",
          credentials: { keys, publicKeyJwk },
          instanceId,
          relayId,
        })
      )
      if (capability.version === 2) {
        const lease = yield* maintainRelayBrowserLease(relaySocket, ready, {
          channel: "console",
          credentials: { keys, publicKeyJwk },
          issue: () =>
            credentialLease.renew({
              kind: "console",
              optInV2: true,
              write,
            }),
          relayId,
          write,
        })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            credentialLease.onAuthorizationChange(() => {
              void lease.renewNow()
            })
          ),
          (unsubscribe) => Effect.sync(unsubscribe)
        )
      } else {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            credentialLease.onAuthorizationChange(() => {
              socket.close(4403, "Browser authorization changed")
            })
          ),
          (unsubscribe) => Effect.sync(unsubscribe)
        )
      }
      yield* Effect.sync(() => {
        socket.send(
          JSON.stringify({ instanceId, type: "console.subscribe", v: 1 })
        )
      })

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerRelayConsoleOperationClient(relayId, instanceId, {
            request: (operation, payload) =>
              inbox.request(socket, instanceId, operation, payload),
          })
        ),
        (unregister) => Effect.sync(unregister)
      )

      const events = inbox.stream.pipe(
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
  return withConsoleTimingSpan(
    timing,
    "Open Relay WebSocket",
    "websocket.console.connect",
    openRelayBrowserSocket({
      browserOrigin,
      channel: "console",
      closeReason: "Console view closed",
      protocols: relayBrowserConsoleProtocols,
      relayId,
    })
  )
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

function canReuseRelayConsoleSocket(
  relaySocket: Effect.Success<ReturnType<typeof openRelayConsoleSocket>>
): boolean {
  return (
    relaySocket.socket.readyState === WebSocket.OPEN &&
    relaySocket.challenge.expiresAt > Date.now()
  )
}

function openHearthConsoleStream(
  relayId: string,
  instanceId: string,
  fallbackMessage: string | null,
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
  return createRelayBrowserSocketInbox(socket, "console")
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Relay browser connection failed")
}
