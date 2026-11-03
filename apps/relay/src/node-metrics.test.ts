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
        const later = exit("a", "1793721601500000000")
        const connections: Array<number | undefined> = []
        const streams: Array<ReadonlyArray<DockerEvent>> = [
          // Out of order, and two containers at the same instant.
          [first, earlier, sameTime],
          // Docker replays the boundary second, then something new.
          [first, earlier, sameTime, later],
        ]
        const engine = {
          events: (
            _filters: unknown,
            options: { readonly since?: number },
            onEvent: (event: DockerEvent) => void
          ) =>
            Effect.suspend(() => {
              connections.push(options.since)
              const events = streams.shift()
              if (!events) return Effect.never
              for (const event of events) onEvent(event)
              return Effect.void
            }),
        } as unknown as DockerEngine

        const fiber = yield* Effect.forkChild(
          watchContainerEvents(() => relayId, engine, config)
        )
        yield* TestClock.adjust("1 second")
        assert.strictEqual(yield* countedExits(relayId), 3)

        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(connections, [undefined, 1793721600, 1793721601])
        assert.strictEqual(yield* countedExits(relayId), 4)
        yield* Fiber.interrupt(fiber)
      })
  )
})
