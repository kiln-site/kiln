import {
  relayBrowserProtocol,
  relayResourceStreamEventSchema,
} from "@workspace/contracts"
import type { RelayResourceStreamEvent } from "@workspace/contracts"
import * as Sentry from "@sentry/tanstackstart-react"
import { Effect, Stream } from "effect"

import {
  maintainRelayBrowserLease,
  isTerminalRelayBrowserFailure,
  openAuthenticatedRelaySocket,
  relayBrowserReconnectSchedule,
} from "@/lib/authenticated-relay-socket"
import { acquireRelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import { getRelayInstanceResources } from "@/server/relay"

export const RELAY_RESOURCE_POLL_INTERVAL_MS = 2_000

export function openRelayResourceStream(
  relayId: string,
  instanceId: string
): Stream.Stream<RelayResourceStreamEvent, Error> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const credentials = yield* Effect.acquireRelease(
        Effect.sync(() => acquireRelayBrowserCredentials(relayId, instanceId)),
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
              Sentry.startSpan(
                {
                  name: "Issue resource capability",
                  op: "http.resources.capability",
                  attributes: { "kiln.channel": "resources" },
                },
                () => credentials.issue({ kind: "resources", optInV2: true })
              ),
            catch: asError,
          })
          if (capability.proxyMode === "hearth") {
            return openHearthResourceStream(relayId, instanceId).pipe(
              Stream.tap((event) =>
                Effect.sync(() => observer.observe(event, "hearth"))
              )
            )
          }
          const span = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Sentry.startInactiveSpan({
                name: "Open authenticated resource socket",
                op: "websocket.resources.connect",
                attributes: { "kiln.channel": "resources" },
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
                try: () => relayResourceStreamEventSchema.parse(message),
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
            : openHearthResourceStream(relayId, instanceId).pipe(
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
  observe: (
    event: RelayResourceStreamEvent,
    transport: "direct" | "hearth"
  ) => void
} {
  const firstEventSpan = Sentry.startInactiveSpan({
    name: "Receive first authoritative resource event",
    op: "stream.resources.first_event",
    attributes: { "kiln.channel": "resources" },
  })
  let pending = true
  return {
    close: () => {
      if (!pending) return
      pending = false
      firstEventSpan.setAttribute("kiln.result", "cancelled")
      firstEventSpan.end()
    },
    observe: (event, transport) => {
      const sampledAt = event.instance.resources?.sampledAt
      const sampleAge = sampledAt ? Date.now() - Date.parse(sampledAt) : NaN
      if (Number.isFinite(sampleAge)) {
        Sentry.metrics.distribution(
          "relay.resources.sample_age",
          Math.max(0, sampleAge),
          {
            unit: "millisecond",
            attributes: { "kiln.transport": transport },
          }
        )
      }
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

export function warmHistoryOnce<T>(): (history: Array<T>) => Array<T> {
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
