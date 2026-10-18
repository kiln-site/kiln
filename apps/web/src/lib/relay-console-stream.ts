import {
  relayBrowserConsoleProtocols,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import type {
  RelayConsoleResource,
  RelayConsoleStreamEvent,
} from "@workspace/contracts"
import { Effect, Exit, Fiber, Result, Scope, Stream } from "effect"

import { consoleCopy } from "@/lib/console-copy"
import { browserTraceparent, startBrowserSpan } from "@/lib/browser-telemetry"
import {
  startConsoleTimingSpan,
  withConsoleTimingSpan,
} from "@/lib/console-performance"
import type {
  ConsoleLoadTiming,
  ConsoleTrace,
} from "@/lib/console-performance"
import {
  authenticateRelayBrowserSocket,
  isTerminalRelayBrowserFailure,
  maintainRelayBrowserLease,
  openRelayBrowserSocket,
  relayBrowserEndpoint,
  relayBrowserReconnectSchedule,
} from "@/lib/authenticated-relay-socket"
import {
  acquireRelayBrowserCredentials,
  relayBrowserAuthorizationSignal,
} from "@/lib/relay-browser-credentials"
import { registerRelayConsoleOperationClient } from "@/lib/relay-console-operations"

export type RelayConsoleTransport = "direct" | "hearth"

export type KilnConsoleStreamEvent =
  | RelayConsoleStreamEvent
  | { type: "reconnecting"; message: string }
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

// Follows a resource's console, directly from its Relay where it can and
// through Hearth otherwise. Only servers take input (`write`).
export function openRelayConsoleStream(
  relayId: string,
  resource: RelayConsoleResource,
  browserOrigin: string | null,
  consoleTransport: RelayConsoleTransport | null = null,
  timing?: ConsoleLoadTiming,
  write = false
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  const { stream } = consoleCopy[resource.kind]
  if (!navigator.onLine) {
    return Stream.fail(
      new RelayConsoleConnectionError(
        "browser_offline",
        `You're offline. Reconnect to the internet to resume the ${stream}.`
      )
    )
  }

  const openHearth = (fallbackMessage: string | null) =>
    openHearthConsoleStream(relayId, resource, fallbackMessage, timing).pipe(
      Stream.catch((cause) =>
        isTerminalRelayBrowserFailure(cause)
          ? Stream.fail(cause)
          : Stream.fail(
              new RelayConsoleConnectionError(
                "hearth_proxy_failed",
                fallbackMessage === null
                  ? `Hearth can reach this Relay, but its secure ${stream} could not be opened.`
                  : `Hearth can reach this Relay, but neither the secure direct stream nor the Hearth fallback could read the ${stream}.`,
                { cause }
              )
            )
      )
    )

  if (consoleTransport === "hearth") return openHearth(null)

  return openDirectRelayConsoleStream(
    relayId,
    resource,
    browserOrigin,
    timing,
    write
  ).pipe(
    Stream.retry(relayBrowserReconnectSchedule),
    Stream.catch((directFailure) =>
      isTerminalRelayBrowserFailure(directFailure)
        ? Stream.fail(directFailure)
        : openHearth(directFallbackMessage(directFailure)).pipe(
            Stream.prepend<KilnConsoleStreamEvent>([
              {
                type: "reconnecting",
                message: `The direct ${stream} failed. Trying to reconnect through Hearth.`,
              },
            ])
          )
    )
  )
}

function openDirectRelayConsoleStream(
  relayId: string,
  resource: RelayConsoleResource,
  browserOrigin: string | null,
  timing?: ConsoleLoadTiming,
  write = false
): Stream.Stream<KilnConsoleStreamEvent, Error> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const instance = prewarmedConsoleInstance(relayId, resource)
      // While this console is open, a link to it prewarms nothing: the Relay
      // would take a second connection as replacing this one.
      if (instance) {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            openConsoles.set(instance, (openConsoles.get(instance) ?? 0) + 1)
          ),
          () =>
            Effect.sync(() => {
              const count = (openConsoles.get(instance) ?? 1) - 1
              if (count > 0) openConsoles.set(instance, count)
              else openConsoles.delete(instance)
            })
        )
      }
      const connect = connectDirectRelayConsole(
        relayId,
        resource,
        browserOrigin,
        timing,
        write
      )
      // Taken and handed its cleanup in one step that cannot be interrupted:
      // the prewarm's connection is now this console's, and closes with it.
      const prewarmed = instance
        ? yield* Effect.acquireRelease(
            Effect.sync(() =>
              takeConsolePrewarm(instance, browserOrigin, write)
            ),
            (prewarm) => (prewarm ? closeConsolePrewarm(prewarm) : Effect.void)
          )
        : undefined
      const { adopted, connection } = prewarmed
        ? yield* adoptConsolePrewarm(prewarmed, connect, timing)
        : { adopted: false, connection: yield* connect }
      const { inbox, socket } = connection

      // Commands and completions go to servers only.
      if (resource.kind === "instance") {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            registerRelayConsoleOperationClient(relayId, resource.id, {
              request: (operation, payload) =>
                inbox.request(socket, resource.id, operation, payload),
            })
          ),
          (unregister) => Effect.sync(unregister)
        )
      }

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
          "websocket.console.snapshot",
          { "kiln.console.prewarmed": adopted }
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

type ConnectedConsole = Effect.Success<
  ReturnType<typeof connectDirectRelayConsole>
>

// Opens a console's Relay socket, authenticates it, keeps its capability
// renewed, and subscribes to the console. Its frames wait in the socket's
// inbox until something reads them.
function connectDirectRelayConsole(
  relayId: string,
  resource: RelayConsoleResource,
  browserOrigin: string | null,
  timing: ConsoleTrace | undefined,
  write: boolean
) {
  return Effect.gen(function* () {
    const socketAttempt = browserOrigin
      ? yield* forkRelayConsoleSocket(browserOrigin, relayId, timing)
      : null
    const credentialLease = yield* Effect.acquireRelease(
      Effect.sync(() =>
        acquireRelayBrowserCredentials(relayId, resource.id, resource.kind)
      ),
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
          credentialLease.issue({ kind: "console", optInV2: true, write }),
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
    const { socket } = relaySocket
    // The Relay's auth and subscription join this console's trace.
    const traceparent = browserTraceparent(timing?.parentSpan())
    const subscription = {
      instanceId: resource.id,
      ...(resource.stream ? { stream: resource.stream } : {}),
      ...(traceparent ? { traceparent } : {}),
      type: "console.subscribe",
      v: 1,
    }
    const ready = yield* withConsoleTimingSpan(
      timing,
      "Authenticate Relay WebSocket",
      "websocket.console.authenticate",
      authenticateRelayBrowserSocket(relaySocket, {
        afterAuth: subscription,
        capability: capability.capability,
        channel: "console",
        credentials: { keys, publicKeyJwk },
        instanceId: resource.id,
        relayId,
        traceparent,
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
    // An older Relay takes the subscription only once authenticated.
    if (!ready.sentAfterAuth)
      yield* Effect.sync(() => socket.send(JSON.stringify(subscription)))
    return relaySocket
  })
}

// A prewarm nobody opens within a few seconds is closed, along with the
// console it subscribed to on the Relay.
const consolePrewarmLifetimeMs = 8_000
// Hovering down a list prewarms each server; keep only the latest few.
const maximumConsolePrewarms = 2

interface ConsolePrewarm {
  // Hands the prewarm to a console: it no longer expires on its own.
  adopt: () => void
  browserOrigin: string
  connection: Fiber.Fiber<Result.Result<ConnectedConsole, Error>>
  discard: () => void
  scope: Scope.Closeable
}

// By `${relayId}:${instanceId}`, then by whether they can write.
const consolePrewarms = new Map<string, ConsolePrewarm>()
const openConsoles = new Map<string, number>()

/**
 * Opens a game server's console from a link the user is about to follow: its
 * Relay socket, capability, authentication and subscription. The console
 * that opens next adopts the connection, with its first output already
 * waiting. A prewarm nobody adopts closes after a few seconds.
 */
export function prewarmRelayConsole(input: {
  browserOrigin: string
  instanceId: string
  relayId: string
  write: boolean
}): void {
  const instance = `${input.relayId}:${input.instanceId}`
  if (openConsoles.has(instance)) return
  const key = consolePrewarmKey(instance, input.write)
  if (consolePrewarms.has(key)) return
  // One prewarm per server: the Relay would take either of two as replacing
  // the other.
  consolePrewarms.get(consolePrewarmKey(instance, !input.write))?.discard()
  for (const [oldest, prewarm] of consolePrewarms) {
    if (consolePrewarms.size < maximumConsolePrewarms) break
    consolePrewarms.delete(oldest)
    prewarm.discard()
  }

  const scope = Scope.makeUnsafe()
  // Its own trace, which the connection's spans and the Relay's nest under,
  // rather than one for each step.
  const span = startBrowserSpan("Prewarm console", {
    attributes: {
      "kiln.console.write": input.write,
      "kiln.operation": "ui.console.prewarm",
    },
  })
  const connection = Effect.runFork(
    connectDirectRelayConsole(
      input.relayId,
      { id: input.instanceId, kind: "instance" },
      input.browserOrigin,
      { parentSpan: () => span },
      input.write
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          span.setAttribute(
            "kiln.console.result",
            Exit.isSuccess(exit)
              ? "ok"
              : Exit.hasInterrupts(exit)
                ? "cancelled"
                : "error"
          )
          span.end(Exit.isFailure(exit) ? exit.cause : undefined)
        })
      ),
      Effect.result,
      Scope.provide(scope)
    )
  )
  const forget = () => {
    clearTimeout(expiry)
    unsubscribe()
    if (consolePrewarms.get(key) === prewarm) consolePrewarms.delete(key)
  }
  const prewarm: ConsolePrewarm = {
    adopt: forget,
    browserOrigin: input.browserOrigin,
    connection,
    discard: () => {
      forget()
      Effect.runFork(closeConsolePrewarm(prewarm))
    },
    scope,
  }
  // A capability issued before an authorization change may no longer hold.
  const unsubscribe = relayBrowserAuthorizationSignal(
    input.relayId,
    input.instanceId
  ).subscribe(() => prewarm.discard())
  const expiry = setTimeout(() => prewarm.discard(), consolePrewarmLifetimeMs)
  consolePrewarms.set(key, prewarm)
}

// The prewarm for the console about to open. Any other for the same server,
// such as one that cannot write, is closed so the two never compete, and so
// is every one when the console reconnects from scratch, as a retry does.
function takeConsolePrewarm(
  instance: string,
  browserOrigin: string | null,
  write: boolean
): ConsolePrewarm | undefined {
  const other = consolePrewarms.get(consolePrewarmKey(instance, !write))
  other?.discard()
  const prewarm = consolePrewarms.get(consolePrewarmKey(instance, write))
  if (!prewarm) return undefined
  if (
    !browserOrigin ||
    !sameRelayBrowserEndpoint(prewarm.browserOrigin, browserOrigin)
  ) {
    prewarm.discard()
    return undefined
  }
  prewarm.adopt()
  return prewarm
}

function adoptConsolePrewarm(
  prewarm: ConsolePrewarm,
  connect: ReturnType<typeof connectDirectRelayConsole>,
  timing: ConsoleLoadTiming | undefined
) {
  return Effect.gen(function* () {
    const exit = yield* Fiber.await(prewarm.connection)
    if (
      Exit.isSuccess(exit) &&
      Result.isSuccess(exit.value) &&
      exit.value.success.socket.readyState === WebSocket.OPEN
    ) {
      timing?.markPrewarmed()
      return { adopted: true, connection: exit.value.success }
    }
    // A prewarm that failed, or whose socket has closed since, such as when
    // a busy console filled its inbox before anyone read it, connects again.
    yield* closeConsolePrewarm(prewarm)
    return { adopted: false, connection: yield* connect }
  })
}

// Only a game server's own console is prewarmed.
function prewarmedConsoleInstance(
  relayId: string,
  resource: RelayConsoleResource
): string | undefined {
  return resource.kind === "instance" && !resource.stream
    ? `${relayId}:${resource.id}`
    : undefined
}

function consolePrewarmKey(instance: string, write: boolean) {
  return `${instance}:${write ? "write" : "read"}`
}

function closeConsolePrewarm(prewarm: ConsolePrewarm) {
  return Fiber.interrupt(prewarm.connection).pipe(
    Effect.andThen(Scope.close(prewarm.scope, Exit.void))
  )
}

function forkRelayConsoleSocket(
  browserOrigin: string,
  relayId: string,
  timing?: ConsoleTrace
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
  timing?: ConsoleTrace
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

function hearthConsoleStreamUrl(
  relayId: string,
  resource: RelayConsoleResource
): string {
  const search = new URLSearchParams({ relayId })
  if (resource.kind !== "instance") search.set("kind", resource.kind)
  if (resource.stream) search.set("stream", resource.stream)
  return `/api/console/${encodeURIComponent(resource.id)}?${search}`
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
  resource: RelayConsoleResource,
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
            fetch(hearthConsoleStreamUrl(relayId, resource), {
              cache: "no-store",
              signal,
            }),
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
              : `The stream through Hearth returned HTTP ${response.status}`
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
            : "The stream through Hearth was interrupted"
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
  op: string,
  attributes: Record<string, unknown> = {}
) {
  return (
    stream: Stream.Stream<RelayConsoleStreamEvent, TError, TRequirements>
  ): Stream.Stream<RelayConsoleStreamEvent, TError, TRequirements> =>
    Stream.suspend(() => {
      const span = startConsoleTimingSpan(timing, name, op)
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value)
      }
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

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Relay browser connection failed")
}
