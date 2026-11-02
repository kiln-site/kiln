/**
 * Relay operations: each change the Relay makes, defined once with the
 * resources it changes, and run by one runner that admits it to the
 * operation lanes, traces and times it. The Relay's counterpart to Hearth's
 * `operation()` (apps/web/src/operations/operation.ts), with the same rules;
 * see docs/relay-operations.md.
 */
import { randomUUID } from "node:crypto"

import { normalizeLocks } from "@workspace/operations"
import { Cause, Clock, Context, Effect, Exit, Metric } from "effect"

import { traceRelayEffect } from "../effect/runtime.js"
import {
  LaneRejectedError,
  type LaneLock,
  type OperationLanes,
} from "../operation-lanes.js"

/**
 * Who an operation runs for. The Relay's own timers and workers are all
 * that run operations so far; Hearth's requests, the browser and SFTP join
 * as they move here.
 */
export interface RelayCaller {
  readonly kind: "timer" | "worker"
}

export interface RelayOperationArgs<Input> {
  readonly input: Input
  readonly caller: RelayCaller
}

export interface RelayOperation<Input, A, E, R> {
  /** Stable, dotted: `relay.edge.reconcile`. Names its span and metrics. */
  readonly name: string
  /** What it changes, as lane keys. */
  readonly locks: (args: RelayOperationArgs<Input>) => ReadonlyArray<LaneLock>
  /**
   * Whether it still applies, checked as it's granted and so after
   * everything admitted before it: a power change someone has since
   * overruled, say. It reads what's current, as it runs synchronously at
   * that moment. One that doesn't apply ends as superseded.
   */
  readonly precondition?: (args: RelayOperationArgs<Input>) => boolean
  /**
   * Work only worth doing now, such as upkeep that runs again shortly:
   * turned away, rather than waiting, when anything is in its way.
   */
  readonly onlyIfFree?: boolean
  /**
   * Upkeep a pause doesn't stop, such as restoring a network's forwarding
   * rules: admitted and kept in line while the Relay is paused, in its turn
   * as ever.
   */
  readonly carriesOnWhilePaused?: boolean
  readonly run: (
    args: RelayOperationArgs<Input> & { readonly operationId: string }
  ) => Effect.Effect<A, E, R>
}

/**
 * Defines an operation taking `Input`, already validated by its caller:
 * `operation<void>()({ name: "relay.edge.reconcile", ... })`.
 */
export const operation =
  <Input>() =>
  <A, E, R>(
    definition: RelayOperation<Input, A, E, R>
  ): RelayOperation<Input, A, E, R> =>
    definition

/** The operation an effect runs in, if any, and the locks it holds. */
export interface RunningOperation {
  readonly id: string
  readonly name: string
  /** Every lock it and the operations it runs inside hold. */
  readonly held: ReadonlyArray<LaneLock>
}

export const CurrentOperation = Context.Reference<RunningOperation | null>(
  "relay/operations/CurrentOperation",
  { defaultValue: () => null }
)

const runDuration = Metric.histogram("relay.operation.duration", {
  description: "How long Relay operations ran, from admission to their end",
  attributes: { unit: "s" },
  boundaries: [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
  ],
})

const refusals = Metric.counter("relay.operation.refused", {
  description: "Relay operations the lanes turned away",
  attributes: { unit: "{operation}" },
  incremental: true,
})

/**
 * Runs `definition` in `lanes`. Inside another operation it runs under the
 * locks that one holds, and must need nothing more: a lock it would take
 * there is a mistake in the outer operation's plan, so it dies naming it
 * rather than wait on what its own caller holds. Otherwise it's admitted,
 * waits its turn, and runs to the end once started, even if its caller
 * stops waiting. A refusal fails with `LaneRejectedError`.
 */
export const runOperation = <Input, A, E, R>(
  lanes: OperationLanes,
  definition: RelayOperation<Input, A, E, R>,
  input: Input,
  caller: RelayCaller
): Effect.Effect<A, E | LaneRejectedError, R> =>
  Effect.gen(function* () {
    const id = randomUUID()
    const parent = yield* CurrentOperation
    const args: RelayOperationArgs<Input> = { caller, input }
    const locks = normalizeLocks(definition.locks(args))
    yield* Effect.annotateCurrentSpan({
      "operation.caller": caller.kind,
      "operation.id": id,
      "operation.locks": locks
        .map((lock) => `${lock.mode}:${lock.key}`)
        .join(" "),
      "operation.parent_id": parent?.id ?? "",
    })
    const admittedAt = yield* Clock.currentTimeMillis
    const work = (held: ReadonlyArray<LaneLock>) =>
      definition.run({ ...args, operationId: id }).pipe(
        Effect.provideService(CurrentOperation, {
          held,
          id,
          name: definition.name,
        })
      )

    const exit = yield* Effect.exit(
      parent
        ? nested(definition, args, locks, parent, work)
        : Effect.gen(function* () {
            const services = yield* Effect.context<R>()
            const precondition = definition.precondition
            return yield* lanes
              .admit({
                label: definition.name,
                locks,
                ...(precondition && { precondition: () => precondition(args) }),
                ...(definition.onlyIfFree && { whenBusy: "refuse" as const }),
                ...(definition.carriesOnWhilePaused && {
                  carriesOnWhilePaused: true,
                }),
              })
              .run(work(locks).pipe(Effect.provideContext(services)))
          })
    )
    const finishedAt = yield* Clock.currentTimeMillis
    const outcome = outcomeOf(exit)
    yield* Effect.annotateCurrentSpan("operation.outcome", outcome)
    yield* outcome === "refused"
      ? Metric.update(
          Metric.withAttributes(refusals, {
            "operation.name": definition.name,
          }),
          1
        )
      : Metric.update(
          Metric.withAttributes(runDuration, {
            "operation.name": definition.name,
            "operation.outcome": outcome,
          }),
          (finishedAt - admittedAt) / 1000
        )
    return yield* exit
  }).pipe((run) => traceRelayEffect(`RelayOperations.${definition.name}`, run))

// Runs inside `parent`, under the locks it holds, once it still applies.
const nested = <Input, A, E, R>(
  definition: RelayOperation<Input, A, E, R>,
  args: RelayOperationArgs<Input>,
  locks: ReadonlyArray<LaneLock>,
  parent: RunningOperation,
  work: (held: ReadonlyArray<LaneLock>) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | LaneRejectedError, R> => {
  const missing = uncovered(locks, parent.held)
  if (missing.length > 0) {
    return Effect.die(
      new Error(
        `${definition.name} needs ${missing.map((lock) => lock.key).join(", ")}, which ${parent.name} doesn't hold: declare them on ${parent.name}`
      )
    )
  }
  if (definition.precondition && !definition.precondition(args)) {
    return Effect.fail(
      new LaneRejectedError({
        message: `${definition.name} no longer applies`,
        reason: "superseded",
      })
    )
  }
  return work(parent.held)
}

/**
 * The locks of `wanted` that what's already held doesn't cover: one held as
 * strongly, or a part (`instance:<id>/lifecycle`) of a whole held
 * exclusively, which nothing else can hold any part of.
 */
function uncovered(
  wanted: ReadonlyArray<LaneLock>,
  held: ReadonlyArray<LaneLock>
): ReadonlyArray<LaneLock> {
  const modes = new Map(held.map((lock) => [lock.key, lock.mode]))
  return wanted.filter((lock) => {
    const mode = modes.get(lock.key)
    if (mode === "exclusive" || (mode === "shared" && lock.mode === "shared"))
      return false
    const at = lock.key.indexOf("/")
    return !(at >= 0 && modes.get(lock.key.slice(0, at)) === "exclusive")
  })
}

type Outcome = "failed" | "interrupted" | "refused" | "succeeded"

function outcomeOf(exit: Exit.Exit<unknown, unknown>): Outcome {
  if (Exit.isSuccess(exit)) return "succeeded"
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted"
  const error = Cause.findErrorOption(exit.cause)
  return error._tag === "Some" && error.value instanceof LaneRejectedError
    ? "refused"
    : "failed"
}
