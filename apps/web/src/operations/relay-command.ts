import { randomUUID } from "node:crypto"

import type { RelayControlOperation } from "@workspace/contracts"
import { RelayOperationLookupSchema } from "@workspace/contracts"
import { Clock, Duration, Effect, Schedule, Schema } from "effect"
import { Activity } from "effect/workflow"

import { RelayUnavailableError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"

/**
 * A Relay change a durable step sent and couldn't settle: refused, partly
 * applied, or with an outcome nobody can know any more. The operation stops
 * here for someone to look.
 */
export class RelayCommandError extends Schema.TaggedError<RelayCommandError>()(
  "RelayCommandError",
  {
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  }
) {}

// The Relay keeps a change's outcome a week from when it started, so a
// change first sent within this long can be asked about, and sent again
// under its ID if the Relay never saw it.
const RESEND_WITHIN = Duration.days(6)

/**
 * Whether a Relay error means trying again later: the connection failed,
 * the Relay is paused, or it said to. Its refusals, which arrive as the same
 * error with a code, are final.
 */
export function relayIsAway(error: unknown): boolean {
  return (
    error instanceof RelayUnavailableError &&
    (error.code === undefined ||
      error.code === "relay_paused" ||
      error.retryable === true)
  )
}

/**
 * One change sent to a Relay as a step of a durable operation, at most once.
 * Its command ID and when it was first sent are stored before it's sent, so
 * a step cut off and run again, as after a restart, asks the Relay how the
 * first send went (`operation.get`) instead of sending it twice:
 *
 * - never seen: sent, under the same ID;
 * - still running: waited on;
 * - done: its reply, while the Relay still has it, else `recover`, which
 *   reads back what the reply would have said;
 * - withdrawn before it ran: sent again, under the same ID;
 * - failed or interrupted: the step fails with why.
 *
 * Its trace context goes with it, so the Relay's spans join the operation's.
 */
export const relayCommand = <A = unknown, R = never>(options: {
  /** Unique within the operation: names its stored steps. */
  readonly name: string
  readonly relayId: string
  readonly operation: RelayControlOperation
  readonly payload: unknown
  readonly timeoutMs?: number
  readonly success?: Schema.Codec<A, unknown>
  /** What the reply said, when the Relay no longer has it. */
  readonly recover?: Effect.Effect<A, RelayCommandError, R>
}) =>
  Effect.gen(function* () {
    const command = yield* Activity.make({
      name: `${options.name}/command`,
      success: Schema.Struct({ id: Schema.String, sentAt: Schema.Number }),
      execute: Effect.map(Clock.currentTimeMillis, (sentAt) => ({
        id: randomUUID(),
        sentAt,
      })),
    })
    return yield* Activity.make({
      name: options.name,
      success: options.success ?? (Schema.Unknown as Schema.Codec<A, unknown>),
      error: RelayCommandError,
      execute: settle(options, command),
    })
  }).pipe(
    Effect.withSpan("Operations.relayCommand", {
      attributes: {
        "operation.step": options.name,
        "relay.id": options.relayId,
        "relay.operation": options.operation,
      },
    })
  )

const settle = <A, R>(
  options: {
    readonly name: string
    readonly relayId: string
    readonly operation: RelayControlOperation
    readonly payload: unknown
    readonly timeoutMs?: number
    readonly success?: Schema.Codec<A, unknown>
    readonly recover?: Effect.Effect<A, RelayCommandError, R>
  },
  command: { readonly id: string; readonly sentAt: number }
): Effect.Effect<A, RelayCommandError, R> =>
  Effect.gen(function* () {
    const relay = yield* promiseEffect(() => activeRelay(options.relayId))
    const send = promiseEffect(() =>
      relayRpc(
        relay,
        options.operation,
        options.payload,
        options.timeoutMs,
        undefined,
        undefined,
        command.id
      )
    )
    const lookup = promiseEffect(() =>
      relayRpc(relay, "operation.get", { operationId: command.id })
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RelayOperationLookupSchema))
    )
    const decode = (reply: unknown) =>
      options.success
        ? Schema.decodeUnknownEffect(options.success)(reply)
        : Effect.succeed(reply as A)

    while (true) {
      const outcome = yield* lookup
      yield* Effect.annotateCurrentSpan("relay.command.lookup", outcome.status)
      switch (outcome.status) {
        case "unknown": {
          const age = (yield* Clock.currentTimeMillis) - command.sentAt
          if (age > Duration.toMillis(RESEND_WITHIN)) {
            return yield* new RelayCommandError({
              code: "outcome_unknown",
              message:
                "The Relay no longer knows how this change went, so it isn't sent again. Check the result before trying again.",
              retryable: false,
            })
          }
          return yield* decode(yield* send)
        }
        case "running":
          yield* Effect.sleep("1 second")
          continue
        case "succeeded":
          if ("result" in outcome) return yield* decode(outcome.result)
          if (options.recover) return yield* options.recover
          return yield* new RelayCommandError({
            code: "result_unavailable",
            message:
              "The change went through, but the Relay no longer has its result",
            retryable: false,
          })
        case "failed":
          if (outcome.code === "operation_withdrawn") {
            return yield* decode(yield* send)
          }
          return yield* new RelayCommandError({
            code: outcome.code,
            message: outcome.message,
            retryable: outcome.retryable,
          })
        case "interrupted":
          return yield* new RelayCommandError({
            code: "interrupted",
            message:
              "The Relay stopped while it ran this change; check the result before trying again",
            retryable: false,
          })
      }
    }
  }).pipe(
    // A connection that dropped, or a Relay that isn't connected or is
    // paused, is asked again; an answer is final.
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("30 seconds"),
      ]),
      while: relayIsAway,
    }),
    Effect.catch((error) =>
      error instanceof RelayCommandError
        ? Effect.fail(error)
        : Effect.fail(
            new RelayCommandError({
              code: "unexpected",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            })
          )
    )
  )
