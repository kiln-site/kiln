import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Metric } from "effect"
import { TestClock } from "effect/testing"

import type { DockerEngine, DockerEvent } from "./docker-engine.js"
import { watchContainerEvents } from "./node-metrics.js"

const config = {
  mode: "node" as const,
  resourceNamespace: "",
  selfContainer: "kiln-relay",
  serverIdLabel: "kiln.instance.id",
}

function exit(container: string, timeNano: string): DockerEvent {
  return {
    Type: "container",
    Action: "die",
    Actor: { ID: container, Attributes: { exitCode: "1", name: container } },
    timeNano,
  }
}

const countedExits = (relayId: string) =>
  Metric.snapshot.pipe(
    Effect.map((snapshots) =>
      snapshots
        .filter(
          (snapshot) =>
            snapshot.id === "relay.container.exits" &&
            snapshot.attributes?.["relay.id"] === relayId
        )
        .reduce(
          (total, snapshot) =>
            total + Number((snapshot.state as { count: number }).count),
          0
        )
    )
  )

describe("container events", () => {
  it.effect(
    "counts each exit once across reordered, simultaneous, and replayed events",
    () =>
      Effect.gen(function* () {
        const relayId = "relay-events-replay"
        // Past 2^53, where neighbouring nanoseconds read as the same number.
        const first = exit("a", "1793721600000000001")
        const earlier = exit("b", "1793721600000000000")
        const sameTime = exit("c", "1793721600000000001")
        const nextSecond = exit("a", "1793721601500000000")
        // From the second before, arriving after one from the next.
        const late = exit("d", "1793721600900000000")
        const afterReconnect = exit("e", "1793721602000000000")
        // What Docker publishes on each connection, after replaying what it
        // holds from `since`'s second, as it does, before going live.
        const published: Array<ReadonlyArray<DockerEvent>> = [
          [first, earlier, sameTime, nextSecond, late],
          [afterReconnect],
        ]
        const history: Array<DockerEvent> = []
        const engine = {
          events: (
            _filters: unknown,
            options: { readonly since?: number },
            onEvent: (event: DockerEvent) => void
          ) =>
            Effect.suspend(() => {
              const since = options.since
              if (since !== undefined) {
                for (const event of history) {
                  if (BigInt(event.timeNano!) / 1_000_000_000n >= BigInt(since))
                    onEvent(event)
                }
              }
              const events = published.shift()
              if (!events) return Effect.never
              for (const event of events) {
                history.push(event)
                onEvent(event)
              }
              return Effect.void
            }),
        } as unknown as DockerEngine

        const fiber = yield* Effect.forkChild(
          watchContainerEvents(() => relayId, engine, config)
        )
        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* countedExits(relayId), 5)

        yield* TestClock.adjust("10 seconds")
        assert.strictEqual(yield* countedExits(relayId), 6)
        yield* Fiber.interrupt(fiber)
      })
  )
})
