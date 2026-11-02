/**
 * Relay operations: each change the Relay makes, defined once with the
 * resources it changes, and run by one runner that admits it to the
 * operation lanes, traces and times it. The Relay's counterpart to Hearth's
 * `operation()` (apps/web/src/operations/operation.ts), with the same rules;
 * see docs/relay-operations.md.
 */
import { randomUUID } from "node:crypto"

import type { RelayControlRequest } from "@workspace/contracts"
import { normalizeLocks } from "@workspace/operations"
import { Cause, Clock, Context, Effect, Exit, Metric, Predicate } from "effect"

import type { RelayClientGrant } from "../effect/state.js"
import { traceRelayEffect } from "../effect/runtime.js"
import {
  LaneRejectedError,
  type LaneLock,
  type LaneTicket,
  type OperationLanes,
} from "../operation-lanes.js"

/**
 * Who an operation runs for: a Hearth's control request, a schedule's step,
 * or the Relay's own timers and workers. The browser and SFTP join as they
 * move here.
 */
export type RelayCaller =
  | { readonly kind: "timer" | "worker" }
  /** A Hearth's request, from the client it came from as it arrived. */
  | {
      readonly kind: "control"
      readonly client: RelayClientGrant
      readonly request: RelayControlRequest
    }
  /**
   * A schedule's step, with the power intent its occurrence noted as it
   * began (`ResourcePower.intent`).
   */
  | { readonly kind: "schedule"; readonly powerIntent: string }

/**
 * Lane keys, or a promise of them when a target must be looked up first:
 * until it settles, nothing admitted after it is granted.
 */
export type RelayLocks =
  | ReadonlyArray<LaneLock>
  | Promise<ReadonlyArray<LaneLock>>

export interface RelayOperationArgs<Input> {
  readonly input: Input
  readonly caller: RelayCaller
}

export interface RelayOperation<Input, A, E, R> {
  /** Stable, dotted: `relay.edge.reconcile`. Names its span and metrics. */
  readonly name: string
  /**
   * Whether its caller may make it: checked before it's admitted and, once
   * it's granted after waiting, again before it runs, so a caller that lost
   * the right meanwhile changes nothing. A failure ends the run.
   */
  readonly authorize?: (
    args: RelayOperationArgs<Input>
  ) => Effect.Effect<void, E, R>
  /** What it changes, as lane keys. */
  readonly locks: (args: RelayOperationArgs<Input>) => RelayLocks
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

/** An operation's place in line, taken as its request arrived. */
export interface RelayReservation {
  /** Its turn in the lanes, for withdrawing it while it waits. */
  readonly ticket: LaneTicket
}

// What each reservation not yet run was taken for; running one removes it,
// so it's used once.
const reservations = new WeakMap<
  RelayReservation,
  { readonly definition: object; readonly locks: RelayLocks }
>()

/**
 * Takes `definition`'s place in line now, before any asynchronous work, so
 * work that must keep the order it arrived in does: a Hearth's request. It
 * isn't authorized yet: the caller checks it as it would before admitting
 * it, then runs it once with `runOperation`'s `reservation`, which checks
 * again if it waited. A caller that gives up first cancels its ticket.
 */
export const reserveOperation = <Input, A, E, R>(
  lanes: OperationLanes,
  definition: RelayOperation<Input, A, E, R>,
  input: Input,
  caller: RelayCaller
): RelayReservation => {
  const args: RelayOperationArgs<Input> = { caller, input }
  const locks = definition.locks(args)
  const precondition = definition.precondition
  const reservation: RelayReservation = {
    ticket: lanes.admit({
      label: definition.name,
      locks,
      ...(precondition && { precondition: () => precondition(args) }),
      ...(definition.onlyIfFree && { whenBusy: "refuse" as const }),
      ...(definition.carriesOnWhilePaused && { carriesOnWhilePaused: true }),
    }),
  }
  reservations.set(reservation, { definition, locks })
  return reservation
}

/**
 * Runs `definition` in `lanes`. Inside another operation it runs under the
 * locks that one holds, and must need nothing more: a lock it would take
 * there is a mistake in the outer operation's plan, so it dies naming it
 * rather than wait on what its own caller holds. Otherwise it's authorized,
 * admitted (or takes the place its `reservation` holds), waits its turn, is
 * authorized again if it waited, and runs to the end once started, even if
 * its caller stops waiting. A refusal fails with `LaneRejectedError`.
 */
export const runOperation = <Input, A, E, R>(
  lanes: OperationLanes,
  definition: RelayOperation<Input, A, E, R>,
  input: Input,
  caller: RelayCaller,
  options: { readonly reservation?: RelayReservation } = {}
): Effect.Effect<A, E | LaneRejectedError, R> =>
  Effect.gen(function* () {
    const id = randomUUID()
    const parent = yield* CurrentOperation
    const args: RelayOperationArgs<Input> = { caller, input }
    yield* Effect.annotateCurrentSpan({
      "operation.caller": caller.kind,
      "operation.id": id,
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
      !parent
        ? admitted(lanes, definition, args, options.reservation, work)
        : options.reservation
          ? Effect.suspend(() => {
              options.reservation?.ticket.cancel()
              return Effect.die(
                new Error(
                  `${definition.name} reserved a place in line, so it can't run inside ${parent.name}`
                )
              )
            })
          : nested(definition, args, parent, work)
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

// Waits its turn in the lanes, from the place it reserved or a new one.
const admitted = <Input, A, E, R>(
  lanes: OperationLanes,
  definition: RelayOperation<Input, A, E, R>,
  args: RelayOperationArgs<Input>,
  reservation: RelayReservation | undefined,
  work: (held: ReadonlyArray<LaneLock>) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | LaneRejectedError, R> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<R>()
    // One that reserved its place was checked by whoever reserved it.
    if (!reservation) yield* authorized(definition, args)
    // Nothing may cut in between taking a place in line and waiting in it,
    // or the place would be kept with nobody waiting.
    const place =
      reservation ??
      reserveOperation(lanes, definition, args.input, args.caller)
    const reserved = reservations.get(place)
    reservations.delete(place)
    if (reserved?.definition !== definition) {
      place.ticket.cancel()
      return yield* Effect.die(
        new Error(
          `${definition.name} was run with a reservation already used, or taken for something else`
        )
      )
    }
    const { ticket } = place
    return yield* ticket.run(
      Effect.gen(function* () {
        const locks = yield* settled(reserved.locks)
        yield* annotateLocks(locks)
        // Whether its caller may still make it, which may have changed
        // while it waited.
        if (!ticket.grantedAtOnce) yield* authorized(definition, args)
        return yield* work(locks)
      }).pipe(Effect.provideContext(services))
    )
  })

// Runs inside `parent`, under the locks it holds, once it still applies.
const nested = <Input, A, E, R>(
  definition: RelayOperation<Input, A, E, R>,
  args: RelayOperationArgs<Input>,
  parent: RunningOperation,
  work: (held: ReadonlyArray<LaneLock>) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | LaneRejectedError, R> =>
  Effect.gen(function* () {
    const locks = yield* settled(definition.locks(args))
    yield* annotateLocks(locks)
    const missing = uncovered(locks, parent.held)
    if (missing.length > 0) {
      return yield* Effect.die(
        new Error(
          `${definition.name} needs ${missing.map((lock) => lock.key).join(", ")}, which ${parent.name} doesn't hold: declare them on ${parent.name}`
        )
      )
    }
    yield* authorized(definition, args)
    if (definition.precondition && !definition.precondition(args)) {
      return yield* new LaneRejectedError({
        message: `${definition.name} no longer applies`,
        reason: "superseded",
      })
    }
    return yield* work(parent.held)
  })

const authorized = <Input, A, E, R>(
  definition: RelayOperation<Input, A, E, R>,
  args: RelayOperationArgs<Input>
): Effect.Effect<void, E, R> =>
  definition.authorize
    ? definition
        .authorize(args)
        .pipe(Effect.withSpan("RelayOperations.authorize"))
    : Effect.void

// Its locks, once any lookup settles; in the lanes, it has by its grant.
const settled = (locks: RelayLocks): Effect.Effect<ReadonlyArray<LaneLock>> =>
  Predicate.isPromise(locks)
    ? Effect.promise(() => locks).pipe(Effect.map(normalizeLocks))
    : Effect.succeed(normalizeLocks(locks))

const annotateLocks = (locks: ReadonlyArray<LaneLock>) =>
  Effect.annotateCurrentSpan(
    "operation.locks",
    locks.map((lock) => `${lock.mode}:${lock.key}`).join(" ")
  )

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
