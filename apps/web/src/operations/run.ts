import type { LaneLock } from "@workspace/operations"
import { Cause, Clock, Effect, Exit } from "effect"

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
      const { id } = yield* admitOperation({
        actorId: options.actorId,
        durable: false,
        input,
        kind: operation.kind,
        locks: operation.locks(input),
        version: operation.version,
      })
      const queuedAt = yield* Clock.currentTimeMillis
      yield* restore(awaitGrant(id)).pipe(
        Effect.onInterrupt(() =>
          finishOperation(id, "cancelled", "Withdrawn before it started").pipe(
            Effect.ignore
          )
        )
      )
      const waitedMs = (yield* Clock.currentTimeMillis) - queuedAt
      yield* startOperation(id)
      // Once it runs it isn't cut off: a caller that gives up now gets its
      // answer late instead of a change half made.
      const exit = yield* effect.pipe(
        Effect.withSpan("Operations.run", {
          attributes: {
            "operation.id": id,
            "operation.kind": operation.kind,
            "operation.wait_ms": waitedMs,
          },
        }),
        Effect.exit
      )
      yield* finishOperation(id, outcomeOf(exit), errorOf(exit)).pipe(
        Effect.ignore
      )
      return yield* exit
    })
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
