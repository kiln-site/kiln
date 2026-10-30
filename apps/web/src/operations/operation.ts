/**
 * Hearth's operations (docs/hearth-operations.md): every change is defined
 * once, with what it changes, and this pipeline runs each the same way,
 * taking its lanes, refusing or waiting, and tracing, auditing and
 * publishing it.
 */
import { randomUUID } from "node:crypto"

import { LaneRejectedError, type LaneLock } from "@workspace/operations"
import { Cause, Clock, Effect, Exit, Metric, Schema } from "effect"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  recordOperationAudit,
  type AuditActor,
  type AuditTarget,
} from "@/lib/hearth-audit.server"

import { CurrentOperation, runningAs, type Initiator } from "./current"
import {
  hearthLanes,
  laneOccupants,
  lanesOpen,
  occupy,
  uncovered,
  vacate,
  withWholes,
} from "./lanes"

export { CurrentOperation, type RunningOperation } from "./current"

/**
 * A change was refused because something it changes is busy. Its message
 * says what, for the person who asked.
 */
export class OperationBusyError extends Schema.TaggedError<OperationBusyError>()(
  "OperationBusyError",
  { message: Schema.String, operation: Schema.String }
) {}

/** Who an operation runs for. */
export interface OperationCaller {
  /** The signed-in person, or none for Hearth's own work. */
  readonly user: AuthenticatedUser | null
  /** The CLI credential acting for `user`, if it came from the CLI. */
  readonly credentialId?: string | null
  /**
   * A person is refused at once when what they asked for is busy; Hearth's
   * own work waits. A schedule acting for someone is Hearth's own work.
   * Defaults to `person` with a user and `system` without.
   */
  readonly initiator?: Initiator
}

export interface OperationArgs<Input> {
  readonly input: Input
  readonly user: AuthenticatedUser | null
  readonly actor: AuditActor
}

export interface Operation<Input, Context, A, E, R> {
  /** Stable, dotted: `domain.add`. Names its spans, metrics and audit. */
  readonly name: string
  /** What it's doing, for those its locks turn away: "Deleting this App". */
  readonly doing: string | ((input: Input) => string)
  /**
   * Checks the caller may run it, and loads what the run needs, before its
   * lanes are taken. Run again once it has waited its turn, since what it
   * read may have changed meanwhile.
   */
  readonly authorize?: (
    args: OperationArgs<Input>
  ) => Effect.Effect<Context, E, R>
  /** What it changes, as lane keys. */
  readonly locks: (
    args: OperationArgs<Input> & { readonly context: Context }
  ) => ReadonlyArray<LaneLock>
  readonly run: (
    args: OperationArgs<Input> & {
      readonly context: Context
      readonly operationId: string
    }
  ) => Effect.Effect<A, E, R>
  /** What the audit records it changed, if anything worth recording. */
  readonly audit?: (
    args: OperationArgs<Input> & { readonly context: Context }
  ) => (AuditTarget & { readonly relayId?: string | null }) | null
  /**
   * Tells open pages what changed. Runs however the run ended, since a
   * failed change can leave something to show; it mustn't throw.
   */
  readonly publish?: (
    args: OperationArgs<Input> & {
      readonly context: Context
      readonly exit: Exit.Exit<A, E>
    }
  ) => void
}

/**
 * Defines an operation taking `Input`, already validated by its caller;
 * see `Operation`: `operation<AddDomainInput>()({ name: "domain.add", ... })`.
 */
export const operation =
  <Input>() =>
  <A, E, R, Context = void>(
    definition: Operation<Input, Context, A, E, R>
  ): Operation<Input, Context, A, E, R> =>
    definition

const durationBoundaries = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
]

const runDuration = Metric.histogram("hearth.operation.duration", {
  description: "How long Hearth operations ran, from admission to their end",
  attributes: { unit: "s" },
  boundaries: durationBoundaries,
})

const waitDuration = Metric.histogram("hearth.operation.wait.duration", {
  description: "How long Hearth operations waited for their lanes",
  attributes: { unit: "s" },
  boundaries: durationBoundaries,
})

const refusals = Metric.counter("hearth.operation.refused", {
  description: "Operations refused because what they change was busy",
  attributes: { unit: "{operation}" },
  incremental: true,
})

/** The person an operation runs for; it needs one. */
export const signedIn = (
  user: AuthenticatedUser | null
): Effect.Effect<AuthenticatedUser> =>
  user
    ? Effect.succeed(user)
    : Effect.die(new Error("This needs a signed-in person"))

/** The audit's actor for a caller. */
export function actorOf(caller: OperationCaller): AuditActor {
  if (!caller.user) return { credentialId: null, kind: "system", userId: null }
  return caller.credentialId
    ? { credentialId: caller.credentialId, kind: "cli", userId: caller.user.id }
    : { credentialId: null, kind: "user", userId: caller.user.id }
}

/**
 * Runs `definition` for `caller`: authorizes it, takes its lanes, refusing
 * or waiting as its initiator does, runs it to the end once it starts, then
 * publishes and audits it. Inside another operation it takes only the locks
 * that one doesn't hold, and must not need any it can't: declare those on
 * the outer one.
 */
export const runOperation = <Input, Context, A, E, R>(
  definition: Operation<Input, Context, A, E, R>,
  input: Input,
  caller: OperationCaller
): Effect.Effect<A, E | OperationBusyError, R | Database> =>
  Effect.gen(function* () {
    const id = randomUUID()
    const parent = yield* CurrentOperation
    const initiator =
      caller.initiator ??
      parent?.initiator ??
      (caller.user ? "person" : "system")
    const args: OperationArgs<Input> = {
      actor: actorOf(caller),
      input,
      user: caller.user,
    }
    const authorize = (definition.authorize?.(args) ??
      Effect.succeed(undefined as Context)) as Effect.Effect<Context, E, R>
    const admittedAt = yield* Clock.currentTimeMillis
    yield* Effect.annotateCurrentSpan({
      "operation.id": id,
      "operation.initiator": initiator,
      "operation.name": definition.name,
      "operation.parent_id": parent?.id ?? "",
    })

    let context = yield* authorize.pipe(Effect.withSpan("Operations.authorize"))
    const locks = withWholes(definition.locks({ ...args, context }))
    yield* Effect.annotateCurrentSpan(
      "operation.locks",
      locks.map((lock) => `${lock.mode}:${lock.key}`).join(" ")
    )
    // Runs the work and everything that follows it, on the fiber that
    // finishes it even if the caller gives up: timings, publishing, the
    // audit, and leaving the operator's view.
    const run = (
      held: ReadonlyArray<LaneLock>,
      waited: boolean,
      label: string | null
    ): Effect.Effect<A, E, R | Database> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const occupant = label ? laneOccupants.get(label) : undefined
        if (occupant) occupant.startedAt = startedAt
        const exit = yield* Effect.gen(function* () {
          // What it read may have changed while it waited.
          if (waited && definition.authorize) {
            context = yield* authorize.pipe(
              Effect.withSpan("Operations.authorize")
            )
          }
          return yield* definition.run({ ...args, context, operationId: id })
        }).pipe(
          (work) =>
            runningAs({ held, id, initiator, name: definition.name }, work),
          Effect.annotateLogs({
            "operation.id": id,
            "operation.name": definition.name,
          }),
          Effect.exit
        )
        const finishedAt = yield* Clock.currentTimeMillis
        yield* record(
          definition.name,
          Exit.isSuccess(exit) ? "succeeded" : outcomeOf(exit.cause),
          { admittedAt, finishedAt, startedAt }
        )
        if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause)) {
          yield* afterRun(definition, args, context, exit, {
            admittedAt,
            finishedAt,
            id,
          })
        }
        return yield* exit
      }).pipe(Effect.ensuring(label ? vacate(label) : Effect.void))

    if (parent) {
      // Run inside its parent, under the locks the parent holds.
      const missing = uncovered(locks, parent.held)
      if (missing.length > 0) {
        return yield* Effect.die(
          new Error(
            `${definition.name} needs ${missing.map((lock) => lock.key).join(", ")}, which ${parent.name} doesn't hold: declare them on ${parent.name}`
          )
        )
      }
      return yield* run(parent.held, false, null)
    }
    yield* awaitLanesOpen(initiator, definition.name)
    const label = `${definition.name}#${id}`
    const services = yield* Effect.context<R | Database>()
    // Admitted and set to be withdrawn in one step that can't be cut off,
    // so a caller that gives up can never leave it holding a place in line.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const ticket = hearthLanes.admit({
          label,
          locks,
          whenBusy: initiator === "person" ? "refuse" : "wait",
        })
        occupy(label, {
          actorId: caller.user?.id ?? null,
          admittedAt,
          doing: doingOf(definition, input),
          durable: false,
          id,
          initiator,
          name: definition.name,
          startedAt: null,
        })
        return restore(
          ticket.run(
            run(locks, !ticket.grantedAtOnce, label).pipe(
              Effect.provideContext(services)
            )
          )
        ).pipe(Effect.onInterrupt(() => Effect.sync(ticket.cancel)))
      })
    ).pipe(
      Effect.catch((error): Effect.Effect<never, E | OperationBusyError> =>
        error instanceof LaneRejectedError
          ? refusal(definition.name, error).pipe(
              Effect.tapError(() =>
                record(definition.name, "refused", {
                  admittedAt,
                  finishedAt: admittedAt,
                  startedAt: admittedAt,
                })
              )
            )
          : Effect.fail(error)
      ),
      // Withdrawn before it started: it leaves the view here. Once it
      // starts, the work's own fiber does.
      Effect.onExit(() =>
        laneOccupants.get(label)?.startedAt === null
          ? vacate(label)
          : Effect.void
      ),
      // Waiting this long is likely work that can't start until
      // something it waits behind ends: say what.
      (waiting) =>
        Effect.raceFirst(
          waiting,
          Effect.sleep(SLOW_WAIT).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                laneOccupants.get(label)?.startedAt === null
                  ? Effect.logWarning(
                      `${definition.name} has waited ${SLOW_WAIT} for its lanes`,
                      hearthLanes
                        .describe()
                        .waiting.find((entry) => entry.label === label)
                        ?.waitingOn ?? []
                    )
                  : Effect.void
              )
            ),
            Effect.andThen(Effect.never)
          )
        )
    )
  }).pipe(Effect.withSpan(`Operations.${definition.name}`))

/**
 * Runs `definition` from a request or the CLI and returns its result, as a
 * server function's handler does.
 */
export function runOperationPromise<Input, Context, A, E, R>(
  definition: Operation<Input, Context, A, E, R>,
  input: Input,
  caller: OperationCaller
): Promise<A> {
  return runAppEffect(
    definition.name,
    runOperation(definition, input, caller) as Effect.Effect<A, unknown, never>
  )
}

const SLOW_WAIT = "30 seconds"

// Notes how a run went on its span and in the metrics.
const record = (
  name: string,
  outcome: Outcome,
  timing: { admittedAt: number; finishedAt: number; startedAt: number }
) =>
  Effect.gen(function* () {
    const metric = { "operation.name": name }
    yield* Effect.annotateCurrentSpan({
      "operation.outcome": outcome,
      "operation.wait_ms": timing.startedAt - timing.admittedAt,
    })
    if (outcome === "refused") return
    yield* Metric.update(
      Metric.withAttributes(waitDuration, metric),
      (timing.startedAt - timing.admittedAt) / 1000
    )
    yield* Metric.update(
      Metric.withAttributes(runDuration, {
        ...metric,
        "operation.outcome": outcome,
      }),
      (timing.finishedAt - timing.admittedAt) / 1000
    )
  })

// How long a person waits for Hearth to finish starting before being told
// to try again; Hearth's own work waits as long as it takes.
const STARTING_WAIT = "15 seconds"

/**
 * Waits for the lanes to open, as they are but while Hearth starts: Hearth's
 * own work as long as it takes, a person up to 15 seconds.
 */
export const awaitLanesOpen = (initiator: Initiator, name: string) =>
  initiator === "system"
    ? lanesOpen
    : lanesOpen.pipe(
        Effect.timeoutOrElse({
          duration: STARTING_WAIT,
          orElse: () =>
            Effect.fail(
              new OperationBusyError({
                message: "Hearth is still starting. Try again shortly.",
                operation: name,
              })
            ),
        })
      )

function doingOf<Input>(
  definition: { readonly doing: string | ((input: Input) => string) },
  input: Input
): string {
  return typeof definition.doing === "string"
    ? definition.doing
    : definition.doing(input)
}

/** The error a refused admission becomes, for the person who asked. */
export const refusal = (name: string, rejected: LaneRejectedError) =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(refusals, { "operation.name": name }),
      1
    )
    if (rejected.reason !== "busy" || !rejected.blockedBy?.length) {
      return yield* new OperationBusyError({
        message: rejected.message,
        operation: name,
      })
    }
    const blocker = laneOccupants.get(rejected.blockedBy[0]!)
    yield* Effect.annotateCurrentSpan(
      "operation.blocked_by",
      blocker?.name ?? rejected.blockedBy[0]!
    )
    return yield* new OperationBusyError({
      message: blocker
        ? `${blocker.doing} is in progress. Try again once it's done.`
        : "Something else is changing this right now. Try again shortly.",
      operation: name,
    })
  })

type Outcome = "failed" | "interrupted" | "refused" | "succeeded"

function outcomeOf(cause: Cause.Cause<unknown>): Outcome {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const error = Cause.findErrorOption(cause)
  return error._tag === "Some" && Schema.is(OperationBusyError)(error.value)
    ? "refused"
    : "failed"
}

// Publishes and audits a run that started. Neither may turn a change that
// went through into an error: the audit is written off the caller's path,
// and either failing is only logged.
const afterRun = <Input, Context, A, E>(
  definition: Operation<Input, Context, A, E, unknown>,
  args: OperationArgs<Input>,
  context: Context,
  exit: Exit.Exit<A, E>,
  timing: { admittedAt: number; finishedAt: number; id: string }
) =>
  Effect.gen(function* () {
    if (definition.publish) {
      yield* Effect.try(() =>
        definition.publish!({ ...args, context, exit })
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Publishing ${definition.name} failed`, error)
        )
      )
    }
    const audit = definition.audit
    if (!audit) return
    const errorCode = Exit.isFailure(exit)
      ? errorTag(Cause.squash(exit.cause))
      : undefined
    yield* Effect.try(() => audit({ ...args, context })).pipe(
      Effect.flatMap((target) =>
        target
          ? recordOperationAudit({
              action: definition.name,
              actor: args.actor,
              errorCode,
              finishedAt: timing.finishedAt,
              occurredAt: timing.admittedAt,
              operationId: timing.id,
              outcome: Exit.isSuccess(exit) ? "succeeded" : "failed",
              relayId: target.relayId ?? null,
              target: { id: target.id, kind: target.kind },
            })
          : Effect.void
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Auditing ${definition.name} failed`, cause)
      ),
      Effect.forkDetach
    )
  })

function errorTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag)
  }
  return error instanceof Error ? error.name : "Error"
}

/**
 * Runs `effect` as the step `name` of whatever runs it, holding `locks`:
 * inside an operation, under its locks; otherwise as Hearth's own work,
 * waiting its turn. For a change several features make, such as a DNS
 * update, that must not interleave with itself.
 */
export const inLanes = <A, E, R>(
  name: string,
  doing: string,
  locks: ReadonlyArray<LaneLock>,
  effect: Effect.Effect<A, E, R>
) =>
  runOperation(
    operation<void>()<A, E, R>({
      doing,
      locks: () => locks,
      name,
      run: () => effect,
    }),
    undefined,
    { user: null }
  )
