import { randomUUID } from "node:crypto"

import type { LaneLock } from "@workspace/operations"
import { Cause, Clock, Effect, Exit, Schedule } from "effect"

import {
  admitOperation,
  awaitGrant,
  finishOperation,
  startOperation,
  type OperationOutcome,
} from "./lanes"

/**
 * A kind of change that waits its turn in Hearth's lanes and runs in the
 * request that asked for it: a quick change, such as renaming something,
 * that answers when it's done. It holds `locks` while it runs.
 */
export interface QuickOperation<Input> {
  readonly kind: string
  readonly version: number
  readonly locks: (input: Input) => ReadonlyArray<LaneLock>
}

export const quickOperation = <Input>(
  definition: QuickOperation<Input>
): QuickOperation<Input> => definition

/**
 * Runs `effect` as an operation: admitted in line with the locks its kind
 * names, started once they're granted, and ended, releasing them, however it
 * ends. A caller that gives up while it waits withdraws it; once it runs, it
 * finishes first.
 */
export const runOperation = <Input, A, E, R>(
  operation: QuickOperation<Input>,
  input: Input,
  effect: Effect.Effect<A, E, R>,
  options: { readonly actorId?: string | null } = {}
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Named first: an admission that committed though its answer was
      // lost is ended by that name, and ending one that didn't changes
      // nothing.
      const id = randomUUID()
      const admitted = yield* admitOperation({
        actorId: options.actorId,
        durable: false,
        id,
        input,
        kind: operation.kind,
        locks: operation.locks(input),
        startIfGranted: true,
        version: operation.version,
      }).pipe(
        Effect.tapError(() =>
          finishReliably(id, "cancelled", "Its admission went unanswered")
        )
      )
      let started = false
      const exit = yield* Effect.gen(function* () {
        const queuedAt = yield* Clock.currentTimeMillis
        // Granted and started as it was admitted, as it usually is, it
        // needn't ask or start again.
        if (!admitted.started) {
          yield* restore(awaitGrant(id))
          yield* startOperation(id)
        }
        const waitedMs = (yield* Clock.currentTimeMillis) - queuedAt
        started = true
        // Once it runs it isn't cut off: a caller that gives up now gets
        // its answer late instead of a change half made.
        return yield* effect.pipe(
          Effect.withSpan("Operations.run", {
            attributes: {
              "operation.id": id,
              "operation.kind": operation.kind,
              "operation.wait_ms": waitedMs,
            },
          })
        )
      }).pipe(Effect.exit)
      yield* started
        ? finishReliably(id, outcomeOf(exit), errorOf(exit))
        : finishReliably(
            id,
            "cancelled",
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? errorOf(exit)
              : "Withdrawn before it started"
          )
      return yield* exit
    })
  )

/**
 * Tries a write of the lanes' own again until MySQL answers, backing off to
 * every 30 seconds.
 */
export const whileMySqlIsAway = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
])

// Ends an operation and releases its locks. Should MySQL refuse, the caller
// isn't kept waiting: it's tried again in the background until it answers,
// so a failed write can't leave the locks held while this Hearth runs.
const finishReliably = (
  id: string,
  outcome: OperationOutcome,
  error?: string
) =>
  finishOperation(id, outcome, error).pipe(
    Effect.catch(() =>
      finishOperation(id, outcome, error).pipe(
        Effect.retry({ schedule: whileMySqlIsAway }),
        Effect.ignore,
        Effect.forkDetach,
        Effect.asVoid
      )
    )
  )

export function outcomeOf(exit: Exit.Exit<unknown, unknown>): OperationOutcome {
  if (Exit.isSuccess(exit)) return "succeeded"
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed"
}

export function errorOf(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}
