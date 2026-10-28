import { assert, layer } from "@effect/vitest"
import { exclusive } from "@workspace/operations"
import { Effect, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { RelayUnavailableError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

import { durableOperation, startDurableOperation } from "./durable"
import { loadOperation } from "./lanes"
import { RelayCommandError, relayCommand } from "./relay-command"
import { testOperationsEngine } from "./test/engine"

// The Relay is the only fake: an outcome journal by command ID, as its
// control socket keeps, and a way for its next reply to go missing or for
// a change to be withdrawn before it runs.
const relay = vi.hoisted(() => ({
  journal: new Map<
    string,
    | { status: "succeeded"; result: unknown }
    | { code: string; message: string; retryable: boolean; status: "failed" }
  >(),
  next: null as null | "loses-reply" | "refuses" | "withdraws",
  sent: [] as Array<string>,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { operationId?: string; action?: string },
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    operationId?: string
  ) => {
    if (operation === "operation.get") {
      return (
        relay.journal.get(payload.operationId ?? "") ?? { status: "unknown" }
      )
    }
    const id = operationId ?? "no-id"
    relay.sent.push(id)
    const next = relay.next
    relay.next = null
    if (next === "refuses") {
      // Refused before it runs, so the journal never has it: as the
      // connection reports it, with its code.
      relay.sent.pop()
      throw RelayUnavailableError.make({
        code: "forbidden",
        message: "Relay permission denied",
        retryable: false,
      })
    }
    if (next === "withdraws") {
      relay.journal.set(id, {
        code: "operation_withdrawn",
        message: "Withdrawn before it ran",
        retryable: true,
        status: "failed",
      })
      throw RelayUnavailableError.make({
        message: "The connection dropped before the change ran",
      })
    }
    const result = { started: payload.action }
    relay.journal.set(id, { result, status: "succeeded" })
    if (next === "loses-reply") {
      throw RelayUnavailableError.make({
        message: "The connection dropped before the Relay answered",
        outcome: "unknown",
      })
    }
    return result
  },
}))

afterAll(() => disposeAppRuntime())

// Starts a game server through its Relay, as a durable step.
const start = durableOperation({
  error: RelayCommandError,
  input: Schema.Struct({ server: Schema.String }),
  kind: "test.start",
  locks: ({ server }) => [exclusive(`instance:${server}`)],
  run: ({ server }) =>
    relayCommand({
      name: "start",
      operation: "instance.action",
      payload: { action: "start", instanceId: server },
      relayId: "relay-one",
      success: Schema.Struct({ started: Schema.String }),
    }),
  success: Schema.Struct({ started: Schema.String }),
  version: 1,
})

const Lanes = testOperationsEngine(start.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const runToEnd = (server: string) =>
  Effect.gen(function* () {
    const id = yield* startDurableOperation(start, { server })
    return yield* loadOperation(id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (record) =>
          record?.state === "succeeded" || record?.state === "failed",
      }),
      Effect.timeout("20 seconds")
    )
  })

describeMysql("Relay commands from durable operations", () => {
  layer(Lanes, { timeout: 60_000 })((it) => {
    it.effect(
      "takes the result of a change whose reply was lost instead of sending it again",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          relay.journal.clear()
          relay.sent.length = 0
          relay.next = "loses-reply"

          const done = yield* runToEnd("survival")

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(relay.sent.length, 1)
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "stops at a change the Relay refuses, rather than asking forever",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          relay.journal.clear()
          relay.sent.length = 0
          relay.next = "refuses"

          const done = yield* runToEnd("survival")

          assert.strictEqual(done?.state, "failed")
          assert.include(done?.error ?? "", "permission denied")
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "sends a change withdrawn before it ran again, under the same ID",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          relay.journal.clear()
          relay.sent.length = 0
          relay.next = "withdraws"

          const done = yield* runToEnd("creative")

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(relay.sent.length, 2)
          assert.strictEqual(relay.sent[0], relay.sent[1])
        }).pipe(TestClock.withLive),
      30_000
    )
  })
})
