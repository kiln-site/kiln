import {
  relayBrowserProtocol,
  relayResourceStreamEventSchema,
} from "@workspace/contracts"
import * as Sentry from "@sentry/tanstackstart-react"
import type { RelayResourceStreamEvent } from "@workspace/contracts"
import { Effect, Exit, Scope, Stream } from "effect"

import {
  maintainRelayBrowserLease,
  openAuthenticatedRelaySocket,
} from "@/lib/authenticated-relay-socket"
import { acquireRelayBrowserCredentials } from "@/lib/relay-browser-credentials"
import { getRelayInstanceResources } from "@/server/relay"

export const RELAY_RESOURCE_POLL_INTERVAL_MS = 2_000

export async function* openRelayResourceStream(
  relayId: string,
  instanceId: string,
  signal: AbortSignal
): AsyncGenerator<RelayResourceStreamEvent> {
  const credentialLease = acquireRelayBrowserCredentials(relayId, instanceId)
  const eventObserver = resourceEventObserver()
  yield* managedAsyncIterable(
    openRelayResourceStreamWithLease(
      relayId,
      instanceId,
      signal,
      credentialLease,
      eventObserver
    ),
    () => {
      eventObserver.close()
      credentialLease.release()
    }
  )
}

async function* openRelayResourceStreamWithLease(
  relayId: string,
  instanceId: string,
  signal: AbortSignal,
  credentialLease: ReturnType<typeof acquireRelayBrowserCredentials>,
  eventObserver: ReturnType<typeof resourceEventObserver>
): AsyncGenerator<RelayResourceStreamEvent> {
  signal.throwIfAborted()
  const { keys, publicKeyJwk } = await credentialLease.credentials
  signal.throwIfAborted()
  // Resource setup intentionally remains serial: a capability is issued
  // before opening this separate backpressure-isolated socket.
  const capability = await Sentry.startSpan(
    {
      name: "Issue resource capability",
      op: "http.resources.capability",
      attributes: { "kiln.channel": "resources" },
    },
    () =>
      credentialLease.issue({
        kind: "resources",
        optInV2: true,
      })
  )
  signal.throwIfAborted()
  if (capability.proxyMode === "hearth") {
    for await (const event of openHearthResourceStream(
      relayId,
      instanceId,
      signal
    )) {
      eventObserver.observe(event, "hearth")
      yield event
    }
    return
  }
  const socketScope = await Effect.runPromise(Scope.make())
  const opened = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        Sentry.startSpan(
          {
            name: "Open authenticated resource socket",
            op: "websocket.resources.connect",
            attributes: { "kiln.channel": "resources" },
          },
          () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const opened = yield* openAuthenticatedRelaySocket({
                  browserOrigin: capability.browserOrigin,
                  capability: capability.capability,
                  channel: "resources",
                  closeReason: "Resource view closed",
                  credentials: { keys, publicKeyJwk },
                  instanceId,
                  protocols: relayBrowserProtocol,
                  relayId,
                })
                if (capability.version === 2) {
                  const lease = yield* maintainRelayBrowserLease(
                    opened,
                    opened.ready,
                    {
                      channel: "resources",
                      credentials: { keys, publicKeyJwk },
                      issue: () =>
                        credentialLease.renew({
                          kind: "resources",
                          optInV2: true,
                        }),
                      relayId,
                      write: false,
                    }
                  )
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
                        opened.socket.close(
                          4403,
                          "Browser authorization changed"
                        )
                      })
                    ),
                    (unsubscribe) => Effect.sync(unsubscribe)
                  )
                }
                return opened
              }).pipe(Scope.provide(socketScope)),
              { signal }
            )
        ),
      catch: asError,
    }).pipe(Effect.tapError(() => Scope.close(socketScope, Exit.void)))
  )
  const { inbox, socket } = opened

  const direct = managedAsyncIterable(
    (async function* () {
      socket.send(
        JSON.stringify({ instanceId, type: "resource.subscribe", v: 1 })
      )

      for (;;) {
        // Resource samples are ordered; concurrent reads could reorder them.
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const nextMessage = await Effect.runPromise(inbox.take)
        yield relayResourceStreamEventSchema.parse(nextMessage)
      }
    })(),
    () => Effect.runPromise(Scope.close(socketScope, Exit.void))
  )
  for await (const observed of Stream.toAsyncIterable(
    Stream.fromAsyncIterable(direct, asError).pipe(
      Stream.map((event) => ({ event, transport: "direct" as const })),
      Stream.catch((cause) =>
        signal.aborted
          ? Stream.fail(cause)
          : Stream.fromAsyncIterable(
              openHearthResourceStream(relayId, instanceId, signal),
              asError
            ).pipe(
              Stream.map((event) => ({
                event,
                transport: "hearth" as const,
              }))
            )
      )
    )
  )) {
    eventObserver.observe(observed.event, observed.transport)
    yield observed.event
  }
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

async function* openHearthResourceStream(
  relayId: string,
  instanceId: string,
  signal: AbortSignal
): AsyncGenerator<RelayResourceStreamEvent> {
  const historyForPoll = warmHistoryOnce()
  let sequence = Date.now()
  while (!signal.aborted) {
    // Polls are deliberately sequential so only one snapshot request is in flight.
    // oxlint-disable-next-line react-doctor/async-await-in-loop
    const snapshot = await getRelayInstanceResources({
      data: { instanceId, relayId },
    })
    yield relayResourceStreamEventSchema.parse({
      history: historyForPoll(snapshot.history),
      instance: snapshot.instance,
      sequence: sequence++,
      type: "resource",
    })
    await waitForPoll(signal)
  }
}

export function warmHistoryOnce<T>(): (history: Array<T>) => Array<T> {
  let delivered = false
  return (history) => {
    if (delivered) return []
    delivered = true
    return history
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(done, RELAY_RESOURCE_POLL_INTERVAL_MS)
    function done() {
      globalThis.clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
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

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Invalid Relay message")
}
