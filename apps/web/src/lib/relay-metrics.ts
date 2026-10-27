import { Cause, Effect, Exit, Fiber, Metric, Predicate } from "effect"
import type { RelayControlOperation } from "@workspace/contracts"

import { forkAppWorker } from "@/effect/runtime"

/**
 * Hearth's side of each Relay's control connection: the requests it waits
 * on, the ones it turns away, and how long the Relay takes to answer. Every
 * user of a Relay shares its connection, so these show when one caller is
 * crowding out the rest. Labels stay to the Relay and small fixed sets,
 * never users or request IDs.
 */
const pendingRequests = Metric.gauge("hearth.relay.requests.pending", {
  description: "Requests Hearth has sent a Relay and is waiting on",
  attributes: { unit: "{request}" },
})

const oldestPending = Metric.gauge("hearth.relay.requests.oldest_age", {
  description: "Time since Hearth sent the oldest request it's waiting on",
  attributes: { unit: "s" },
})

const unsettledChanges = Metric.gauge("hearth.relay.changes.unsettled", {
  description:
    "Changes whose connection dropped before the Relay answered, whose outcome Hearth is still asking for",
  attributes: { unit: "{change}" },
})

const refusedRequests = Metric.counter("hearth.relay.requests.refused", {
  description:
    "Requests to a Relay turned away because Hearth or the Relay was full",
  attributes: { unit: "{request}" },
  incremental: true,
})

const requestDuration = Metric.histogram("hearth.relay.request.duration", {
  description: "Time from sending a request to a Relay until it settled",
  attributes: { unit: "s" },
  boundaries: [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
  ],
})

/**
 * What Hearth carries for Relays it passes transfers through to
 * (relay-passthrough-limits.server.ts): those open now, the bytes each way,
 * and those turned away for want of a slot.
 */
const passthroughOpen = Metric.gauge("hearth.relay.passthrough.open", {
  description: "Transfers Hearth is carrying through to a Relay now",
  attributes: { unit: "{transfer}" },
})

const passthroughBytes = Metric.counter("hearth.relay.passthrough.bytes", {
  description:
    "Bytes Hearth carried to or from a Relay through its pass-through",
  attributes: { unit: "By" },
  incremental: true,
})

const passthroughRefused = Metric.counter("hearth.relay.passthrough.refused", {
  description: "Transfers through Hearth turned away because no slot came free",
  attributes: { unit: "{transfer}" },
  incremental: true,
})

const sampleInterval = "10 seconds"

/** Counts a request Hearth didn't send because the connection was full. */
export function countHearthRefusal(relayId: string): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(refusedRequests, {
      "relay.id": relayId,
      reason: "hearth_limit",
    }),
    1
  )
}

/**
 * Records how a request Hearth sent settled. One the Relay refused for lack
 * of room is also counted as refused.
 */
export function recordRelayRequest(
  relayId: string,
  operation: RelayControlOperation,
  elapsedMs: number,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> {
  const outcome = requestOutcome(exit)
  const recorded = Metric.update(
    Metric.withAttributes(requestDuration, {
      "relay.id": relayId,
      "relay.operation": operation,
      outcome,
    }),
    elapsedMs / 1000
  )
  return outcome === "refused"
    ? recorded.pipe(
        Effect.andThen(
          Metric.update(
            Metric.withAttributes(refusedRequests, {
              "relay.id": relayId,
              reason: "relay_limit",
            }),
            1
          )
        )
      )
    : recorded
}

function requestOutcome(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return "ok"
  if (Cause.hasInterruptsOnly(exit.cause)) return "cancelled"
  const error = Cause.squash(exit.cause)
  if (Cause.isTimeoutError(error)) return "timeout"
  if (
    Predicate.hasProperty(error, "code") &&
    error.code === "too_many_requests"
  ) {
    return "refused"
  }
  return "error"
}

/** A Relay connection as the sampler reads it. */
export interface RelayConnectionCapacity {
  readonly relayId: string
  readonly pending: number
  /** Since Hearth sent the oldest request it's waiting on; 0 with none. */
  readonly oldestPendingMs: number
  readonly unsettled: number
}

// Relays sampled before, so one whose connection is gone reads zero rather
// than its last value.
const sampledRelays = new Set<string>()

const sampleConnections = (
  read: () => ReadonlyArray<RelayConnectionCapacity>
) =>
  Effect.suspend(() => {
    const connections = read()
    const current = new Set(connections.map(({ relayId }) => relayId))
    const gone = [...sampledRelays].filter((relayId) => !current.has(relayId))
    for (const relayId of gone) sampledRelays.delete(relayId)
    for (const relayId of current) sampledRelays.add(relayId)
    return Effect.forEach(
      [
        ...connections,
        ...gone.map((relayId) => ({
          relayId,
          oldestPendingMs: 0,
          pending: 0,
          unsettled: 0,
        })),
      ],
      ({ oldestPendingMs, pending, relayId, unsettled }) => {
        const at = (metric: Metric.Gauge<number>) =>
          Metric.withAttributes(metric, { "relay.id": relayId })
        return Effect.all(
          [
            Metric.update(at(pendingRequests), pending),
            Metric.update(at(oldestPending), oldestPendingMs / 1000),
            Metric.update(at(unsettledChanges), unsettled),
          ],
          { discard: true }
        )
      },
      { discard: true }
    )
  })

/** What Hearth carried for one Relay, as the sampler reads it. */
export interface RelayPassthroughSample {
  readonly relayId: string
  readonly open: number
  readonly bytesToRelay: number
  readonly bytesFromRelay: number
  readonly refused: number
}

// The totals last recorded for each Relay, so counters only add what's new.
const recordedPassthrough = new Map<string, RelayPassthroughSample>()

// Reads afresh each time the sample runs, not once.
export const samplePassthrough = (
  read: () => ReadonlyArray<RelayPassthroughSample>
) =>
  Effect.suspend(() =>
    Effect.forEach(
      read(),
      (sample) => {
        const last = recordedPassthrough.get(sample.relayId)
        recordedPassthrough.set(sample.relayId, sample)
        const relay = { "relay.id": sample.relayId }
        return Effect.all(
          [
            Metric.update(
              Metric.withAttributes(passthroughOpen, relay),
              sample.open
            ),
            Metric.update(
              Metric.withAttributes(passthroughBytes, {
                ...relay,
                direction: "to_relay",
              }),
              sample.bytesToRelay - (last?.bytesToRelay ?? 0)
            ),
            Metric.update(
              Metric.withAttributes(passthroughBytes, {
                ...relay,
                direction: "from_relay",
              }),
              sample.bytesFromRelay - (last?.bytesFromRelay ?? 0)
            ),
            Metric.update(
              Metric.withAttributes(passthroughRefused, relay),
              sample.refused - (last?.refused ?? 0)
            ),
          ],
          { discard: true }
        )
      },
      { discard: true }
    )
  )

declare global {
  var kilnRelayMetricsWorker: Fiber.Fiber<void> | undefined
}

/**
 * Records each Relay connection's gauges every ten seconds, and what Hearth
 * carried for each Relay through its pass-through.
 */
export function startRelayMetrics(
  read: () => ReadonlyArray<RelayConnectionCapacity>,
  readPassthrough: () => ReadonlyArray<RelayPassthroughSample> = () => []
) {
  globalThis.kilnRelayMetricsWorker ??= forkAppWorker(
    sampleConnections(read).pipe(
      Effect.andThen(samplePassthrough(readPassthrough)),
      Effect.andThen(Effect.sleep(sampleInterval)),
      Effect.forever
    )
  )
}

/** Runtime disposal does not interrupt forked workers, so stop it first. */
export function stopRelayMetrics(): Promise<void> {
  const worker = globalThis.kilnRelayMetricsWorker
  globalThis.kilnRelayMetricsWorker = undefined
  return worker ? Effect.runPromise(Fiber.interrupt(worker)) : Promise.resolve()
}

// In development, a reloaded module starts a worker running its new code.
if (import.meta.hot) import.meta.hot.dispose(() => stopRelayMetrics())
