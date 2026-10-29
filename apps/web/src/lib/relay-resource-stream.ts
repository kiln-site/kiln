import {
  relayBrowserProtocol,
  relayResourceStreamEventSchema,
  relayWorkloadUsageEventSchema,
} from "@workspace/contracts"
import type {
  RelayBrowserResourceKind,
  RelayResourceStreamEvent,
  RelayWorkloadResourceKind,
  RelayWorkloadUsage,
  RelayWorkloadUsageEvent,
  RelayWorkloadUsageHistory,
} from "@workspace/contracts"
import { Effect, Stream } from "effect"

import { startBrowserSpan, traceBrowser } from "@/lib/browser-telemetry"
import {
  maintainRelayBrowserLease,
  isTerminalRelayBrowserFailure,
  openAuthenticatedRelaySocket,
  relayBrowserReconnectSchedule,
} from "@/lib/authenticated-relay-socket"
import { acquireRelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import { getRelayInstanceResources } from "@/server/relay"
import { getWorkloadUsage } from "@/server/workload-usage"

export const RELAY_RESOURCE_POLL_INTERVAL_MS = 2_000

/** A game server's usage, from its Relay or, failing that, through Hearth. */
export function openRelayResourceStream(
  relayId: string,
  instanceId: string
): Stream.Stream<RelayResourceStreamEvent, Error> {
  return openUsageStream({
    decode: (message) => relayResourceStreamEventSchema.parse(message),
    id: instanceId,
    kind: "instance",
    poll: openHearthResourceStream,
    relayId,
  })
}

/** An App's or database's usage, as a game server's arrives. */
export function openRelayWorkloadUsageStream(
  relayId: string,
  kind: RelayWorkloadResourceKind,
  id: string
): Stream.Stream<RelayWorkloadUsageEvent, Error> {
  return openUsageStream({
    decode: (message) => relayWorkloadUsageEventSchema.parse(message),
    id,
    kind,
    poll: (relayId, id) => openHearthWorkloadUsageStream(relayId, kind, id),
    relayId,
  })
}

function openUsageStream<Event>(options: {
  readonly decode: (message: unknown) => Event
  readonly id: string
  readonly kind: RelayBrowserResourceKind
  readonly poll: (relayId: string, id: string) => Stream.Stream<Event, Error>
  readonly relayId: string
}): Stream.Stream<Event, Error> {
  const { decode, id: instanceId, kind, poll, relayId } = options
  return Stream.unwrap(
    Effect.gen(function* () {
      const credentials = yield* Effect.acquireRelease(
        Effect.sync(() =>
          acquireRelayBrowserCredentials(relayId, instanceId, kind)
        ),
        (lease) => Effect.sync(lease.release)
      )
      const observer = yield* Effect.acquireRelease(
        Effect.sync(resourceEventObserver),
        (observer) => Effect.sync(observer.close)
      )
      const direct = Stream.unwrap(
        Effect.gen(function* () {
          const keys = yield* Effect.tryPromise({
            try: () => credentials.credentials,
            catch: asError,
          })
          const capability = yield* Effect.tryPromise({
            try: () =>
              traceBrowser(
                "Issue resource capability",
                {
                  "kiln.operation": "http.resources.capability",
                  "kiln.channel": "resources",
                },
                () => credentials.issue({ kind: "resources", optInV2: true })
              ),
            catch: asError,
          })
          if (capability.proxyMode === "hearth") {
            return poll(relayId, instanceId).pipe(
              Stream.tap((event) =>
                Effect.sync(() => observer.observe(event, "hearth"))
              )
            )
          }
          const span = yield* Effect.acquireRelease(
            Effect.sync(() =>
              startBrowserSpan("Open authenticated resource socket", {
                attributes: {
                  "kiln.operation": "websocket.resources.connect",
                  "kiln.channel": "resources",
                },
              })
            ),
            (span) => Effect.sync(() => span.end())
          )
          const opened = yield* openAuthenticatedRelaySocket({
            browserOrigin: capability.browserOrigin,
            capability: capability.capability,
            channel: "resources",
            closeReason: "Resource view closed",
            credentials: keys,
            instanceId,
            protocols: relayBrowserProtocol,
            relayId,
          })
          span.end()
          if (capability.version === 2) {
            const lease = yield* maintainRelayBrowserLease(
              opened,
              opened.ready,
              {
                channel: "resources",
                credentials: keys,
                issue: () =>
                  credentials.renew({ kind: "resources", optInV2: true }),
                relayId,
                write: false,
              }
            )
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                credentials.onAuthorizationChange(lease.renewNow)
              ),
              (unsubscribe) => Effect.sync(unsubscribe)
            )
          } else {
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                credentials.onAuthorizationChange(() => {
                  opened.socket.close(4403, "Browser authorization changed")
                })
              ),
              (unsubscribe) => Effect.sync(unsubscribe)
            )
          }
          yield* Effect.try({
            try: () =>
              opened.socket.send(
                JSON.stringify({ instanceId, type: "resource.subscribe", v: 1 })
              ),
            catch: asError,
          })
          return opened.inbox.stream.pipe(
            Stream.mapEffect((message) =>
              Effect.try({
                try: () => decode(message),
                catch: asError,
              })
            ),
            Stream.tap((event) =>
              Effect.sync(() => observer.observe(event, "direct"))
            )
          )
        })
      )
      // Includes setup failure. Scoped direct resources are released before
      // polling starts, and interrupting the consumer interrupts either transport.
      return direct.pipe(
        Stream.retry(relayBrowserReconnectSchedule),
        Stream.catch((cause) =>
          isTerminalRelayBrowserFailure(cause)
            ? Stream.fail(cause)
            : poll(relayId, instanceId).pipe(
                Stream.tap((event) =>
                  Effect.sync(() => observer.observe(event, "hearth"))
                )
              )
        )
      )
    })
  )
}

function resourceEventObserver(): {
  close: () => void
  observe: (event: unknown, transport: "direct" | "hearth") => void
} {
  const firstEventSpan = startBrowserSpan(
    "Receive first authoritative resource event",
    {
      attributes: {
        "kiln.operation": "stream.resources.first_event",
        "kiln.channel": "resources",
      },
    }
  )
  let pending = true
  return {
    close: () => {
      if (!pending) return
      pending = false
      firstEventSpan.setAttribute("kiln.result", "cancelled")
      firstEventSpan.end()
    },
    observe: (_event, transport) => {
      if (!pending) return
      pending = false
      firstEventSpan.setAttribute("kiln.result", "ok")
      firstEventSpan.setAttribute("kiln.transport", transport)
      firstEventSpan.end()
    },
  }
}

function openHearthResourceStream(
  relayId: string,
  instanceId: string
): Stream.Stream<RelayResourceStreamEvent, Error> {
  return Stream.suspend(() => {
    const historyForPoll = warmHistoryOnce()
    let sequence = Date.now()
    let first = true
    return Stream.fromEffectRepeat(
      Effect.gen(function* () {
        if (!first) yield* Effect.sleep(RELAY_RESOURCE_POLL_INTERVAL_MS)
        first = false
        const snapshot = yield* Effect.tryPromise({
          try: (signal) =>
            getRelayInstanceResources({
              data: { instanceId, relayId },
              signal,
            }),
          catch: asError,
        })
        return yield* Effect.try({
          try: () =>
            relayResourceStreamEventSchema.parse({
              history: historyForPoll(snapshot.history),
              instance: snapshot.instance,
              sequence: sequence++,
              type: "resource",
            }),
          catch: asError,
        })
      })
    )
  })
}

// Polls Hearth for an App's or database's usage. Its history comes first,
// one window to a request: the resource's, then each service's.
function openHearthWorkloadUsageStream(
  relayId: string,
  kind: RelayWorkloadResourceKind,
  id: string
): Stream.Stream<RelayWorkloadUsageEvent, Error> {
  return Stream.suspend(() => {
    let sequence = Date.now()
    let pending: Array<RelayWorkloadUsageHistory> | null = null
    const read = (history: RelayWorkloadUsageHistory) =>
      Effect.tryPromise({
        try: (signal): Promise<RelayWorkloadUsage> =>
          getWorkloadUsage({
            data:
              kind === "app"
                ? { history, id, kind, relayId }
                : {
                    history: typeof history === "object" ? "none" : history,
                    id,
                    kind,
                    relayId,
                  },
            signal,
          }),
        catch: asError,
      })
    return Stream.fromEffectRepeat(
      Effect.gen(function* () {
        let history: RelayWorkloadUsageHistory
        if (pending === null) {
          history = "resource"
        } else if (pending.length > 0) {
          history = pending.shift()!
        } else {
          yield* Effect.sleep(RELAY_RESOURCE_POLL_INTERVAL_MS)
          history = "none"
        }
        const usage = yield* read(history)
        if (pending === null) {
          pending = usage.services.map(({ service }) => ({ service }))
        }
        return yield* Effect.try({
          try: () =>
            relayWorkloadUsageEventSchema.parse({
              ...usage,
              id,
              kind,
              sequence: sequence++,
              type: "resource.usage",
            }),
          catch: asError,
        })
      })
    )
  })
}

function warmHistoryOnce<T>(): (history: Array<T>) => Array<T> {
  let delivered = false
  return (history) => {
    if (delivered) return []
    delivered = true
    return history
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Invalid Relay message")
}
