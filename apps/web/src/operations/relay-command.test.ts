import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { RelayUnavailableError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

import { durableOperation, startDurableOperation } from "./durable"
import { loadOperation } from "./records"
import { RelayCommandError, relayCommand } from "./relay-command"
import { testOperationsEngine } from "./test/engine"

// The Relay is the only fake: the starts it applied, an outcome journal by
// command ID, as its control socket keeps, and a way for its next reply to
// go missing as the Relay's state is rebuilt, which starts a new journal.
const relay = vi.hoisted(() => ({
  applied: [] as Array<string>,
  journalId: "journal-one",
  journal: new Map<
    string,
    | { status: "succeeded"; result: unknown }
    | { code: string; message: string; retryable: boolean; status: "failed" }
  >(),
  next: null as null | "loses-reply-and-rebuilds",
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayJournal: async () => ({
    clientId: "hearth-one",
    journalId: relay.journalId,
  }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { operationId?: string; action?: string; instanceId?: string },
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    frame: {
      operationId?: string
      journal?: { journalId: string }
    } = {}
  ) => {
    if (frame.journal && frame.journal.journalId !== relay.journalId) {
      throw RelayUnavailableError.make({
        code: "journal_changed",
        message: "This Relay's state was rebuilt since that change was sent",
        retryable: false,
      })
    }
    const operationId = frame.operationId
    if (operation === "operation.get") {
      return (
        relay.journal.get(payload.operationId ?? "") ?? { status: "unknown" }
      )
    }
    const id = operationId ?? "no-id"
    const result = { started: payload.action }
    relay.applied.push(payload.instanceId ?? "")
    relay.journal.set(id, { result, status: "succeeded" })
    if (relay.next === "loses-reply-and-rebuilds") {
      relay.next = null
      relay.journal.clear()
      relay.journalId = "journal-two"
      throw RelayUnavailableError.make({
        message: "The connection dropped before the Relay answered",
        outcome: "unknown",
      })
    }
    return result
  },
}))

afterAll(() => disposeAppRuntime())

const resetRelay = () => {
  relay.applied.length = 0
  relay.journal.clear()
  relay.journalId = "journal-one"
  relay.next = null
}

// Starts a game server through its Relay, as a durable step.
const start = durableOperation({
  error: RelayCommandError,
  input: Schema.Struct({ server: Schema.String }),
  kind: "test.start",
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
      "stops instead of sending a change again to a Relay whose state was rebuilt",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          resetRelay()
          relay.next = "loses-reply-and-rebuilds"

          const done = yield* runToEnd("survival")

          // The rebuilt Relay doesn't know the change, but it ran: once.
          assert.strictEqual(done?.state, "failed")
          assert.include(done?.error ?? "", "nobody can say")
          assert.deepStrictEqual(relay.applied, ["survival"])
        }).pipe(TestClock.withLive),
      30_000
    )
  })
})
