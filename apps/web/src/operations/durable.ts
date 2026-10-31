import { randomUUID } from "node:crypto"

import type { LaneLock } from "@workspace/operations"

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  Tracer,
} from "effect"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"

import { Database } from "@/effect/database"
import type { DatabaseError } from "@/effect/errors"

import { OperationsEngineService, withOperationsEngine } from "./engine-service"
import {
  hearthLanes,
  laneOccupants,
  lanesOpen,
  occupy,
  vacate,
  withWholes,
  type Initiator,
} from "./lanes"
import { runningAs } from "./current"
import {
  awaitLanesOpen,
  awaitTurn,
  OperationBusyError,
  personWaitUntil,
  personWhenBusy,
} from "./operation"
import {
  awaitOperationEnd,
  findOperation,
  finishOperation,
  loadOperation,
  runningOperations,
  recordExecution,
  releaseIdempotencyKey,
  startWaitingOperation,
  waitingOperations,
  recordOperation,
  type OperationOutcome,
} from "./records"

/**
 * A kind of long change that survives a restart: recorded, then run as a
 * workflow whose finished steps are stored and not run again.
 */
export interface DurableOperation<
  Input extends Schema.Top = Schema.Top,
  Success extends Schema.Top = Schema.Top,
  Failure extends Schema.Top = Schema.Top,
  R = never,
> {
  readonly kind: string
  readonly version: number
  readonly input: Input
  /** What it holds from its start until it ends, across restarts. */
  readonly locks: (input: Input["Type"]) => ReadonlyArray<LaneLock>
  /** What it's doing, for those its locks turn away. */
  readonly doing: (input: Input["Type"]) => string
  /**
   * Whether the person who queued it may still, checked once its turn
   * comes, also after a restart, from what's recorded of it.
   */
  readonly authorize?: (
    input: Input["Type"],
    actorId: string
  ) => Effect.Effect<void, unknown, Database>
  readonly workflow: Workflow.Workflow<
    string,
    Schema.Struct<{ readonly operationId: Schema.String }>,
    Success,
    Failure
  >
  /** Registers the workflow with the engine, in `HearthWorkflows`. */
  readonly layer: Layer.Layer<
    never,
    never,
    | WorkflowEngine.WorkflowEngine
    | Database
    | OperationsEngineService
    | Exclude<R, WorkflowEngine.WorkflowInstance>
  >
}

// Every durable kind by `kind@version`, to start the workflow of one granted.
const durableKinds = new Map<string, DurableOperation>()

export const durableOperation = <
  Input extends Schema.Top,
  Success extends Schema.Top = Schema.Void,
  Failure extends Schema.Top = Schema.Never,
  R = never,
>(options: {
  readonly kind: string
  readonly version: number
  readonly input: Input
  readonly success?: Success
  readonly error?: Failure
  /**
   * What it changes, held from its start until it ends. Most need none:
   * one that only does its own work, such as sending an invitation, is kept
   * to one run by its idempotency key instead.
   */
  readonly locks?: (input: Input["Type"]) => ReadonlyArray<LaneLock>
  readonly doing?: (input: Input["Type"]) => string
  /**
   * Whether the person who queued it may still, from what's recorded: its
   * input and who asked. Checked when it's queued and again when its turn
   * comes, also after a restart.
   */
  readonly authorize?: (
    input: Input["Type"],
    actorId: string
  ) => Effect.Effect<void, unknown, Database>
  readonly run: (
    input: Input["Type"],
    operation: { readonly id: string }
  ) => Effect.Effect<Success["Type"], Failure["Type"], R>
}): DurableOperation<Input, Success, Failure, R> => {
  const workflow = Workflow.make(
    `Operation/${options.kind}@${options.version}`,
    {
      error: options.error,
      idempotencyKey: ({ operationId }) => operationId,
      payload: { operationId: Schema.String },
      success: options.success,
    }
  )
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* ({ operationId }) {
      const instance = yield* WorkflowEngine.WorkflowInstance
      const exit = yield* Effect.gen(function* () {
        const input = yield* Activity.make({
          name: "Operations.load",
          success: options.input,
          execute: loadInput(options.input, operationId),
        })
        // Only to link the run to the request that started it.
        const record = yield* loadOperation(operationId).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        return yield* options.run(input, { id: operationId }).pipe(
          // Its steps run under the locks it holds while it runs.
          (work) =>
            runningAs(
              {
                // As its definition declares them, so one recorded before
                // operations kept their locks holds them too.
                held: withWholes(options.locks?.(input) ?? []),
                id: operationId,
                initiator: "system",
                name: options.kind,
              },
              work
            ),
          Effect.annotateLogs({
            "operation.id": operationId,
            "operation.name": options.kind,
          }),
          Effect.withSpan(`Operations.${options.kind}`, {
            attributes: {
              "operation.durable": true,
              "operation.id": operationId,
              "operation.name": options.kind,
            },
            links: record?.trace ? [linkTo(record.trace)] : [],
          })
        )
      }).pipe(Effect.exit)
      // Waiting to resume, or stopped with Hearth: the workflow runs again
      // later, and ends then.
      if (
        Exit.isFailure(exit) &&
        Cause.hasInterruptsOnly(exit.cause) &&
        !instance.interrupted
      ) {
        return yield* exit
      }
      yield* Activity.make({
        name: "Operations.finish",
        execute: finishOperation(
          operationId,
          outcomeOf(exit),
          errorOf(exit)
        ).pipe(Effect.retry({ schedule: whileMySqlIsAway }), Effect.orDie),
      })
      return yield* exit
    })
  ) as DurableOperation<Input, Success, Failure, R>["layer"]
  const definition: DurableOperation<Input, Success, Failure, R> = {
    ...(options.authorize && { authorize: options.authorize }),
    doing: options.doing ?? (() => "Another change"),
    input: options.input,
    kind: options.kind,
    locks: options.locks ?? (() => []),
    layer,
    version: options.version,
    workflow: workflow as DurableOperation<
      Input,
      Success,
      Failure,
      R
    >["workflow"],
  }
  durableKinds.set(
    `${options.kind}@${options.version}`,
    definition as unknown as DurableOperation
  )
  return definition
}

/**
 * Starts a durable operation, returning its ID: takes its lanes, records
 * it, and starts its workflow, holding its locks until it ends. It's
 * admitted as every operation is: a person waits behind the same kind of
 * change and is refused by work replacing or removing what it changes;
 * Hearth's own work waits. `authorize`, the person's permission, is checked
 * first and again once it has waited, before it's recorded. With an
 * idempotency key, starting it again returns the same operation. Should the
 * workflow not start, as while the engine can't, the operation stays
 * recorded and startup's sweep starts it.
 */
export const startDurableOperation = <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  R,
  AuthorizeError = never,
>(
  operation: DurableOperation<Input, Success, Failure, R>,
  input: Input["Type"],
  options: {
    readonly actorId?: string | null
    readonly authorize?: Effect.Effect<void, AuthorizeError, Database>
    readonly idempotencyKey?: string
    readonly initiator?: Initiator
  } = {}
): Effect.Effect<
  string,
  DatabaseError | OperationBusyError | AuthorizeError,
  Database
> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("operation.name", operation.kind)
    const authorize = options.authorize ?? Effect.void
    yield* authorize
    if (options.idempotencyKey !== undefined) {
      const found = yield* findOperation(operation.kind, options.idempotencyKey)
      if (found) {
        yield* Effect.annotateCurrentSpan("operation.id", found.id)
        return found.id
      }
    }
    const encoded = yield* Schema.encodeUnknownEffect(
      Schema.toCodecJson(operation.input)
    )(input).pipe(Effect.orDie) as Effect.Effect<unknown>
    const locks = withWholes(operation.locks(input))
    const id = randomUUID()
    yield* Effect.annotateCurrentSpan("operation.id", id)
    const start = recordOperation({
      actorId: options.actorId,
      id,
      idempotencyKey: options.idempotencyKey,
      input: encoded,
      kind: operation.kind,
      locks,
      version: operation.version,
    }).pipe(
      Effect.tap((recorded) =>
        recorded.existing ? Effect.void : dispatchSoon(recorded.id)
      )
    )
    const initiator =
      options.initiator ?? (options.actorId ? "person" : "system")
    // Nothing starts while startup takes back the locks of what's running.
    yield* awaitLanesOpen(initiator, operation.kind)
    if (locks.length === 0) return (yield* start).id
    const started = yield* Deferred.make<string>()
    const services = yield* Effect.context<Database>()
    const waitUntil = yield* personWaitUntil
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const holder = yield* holdLanes<DatabaseError | AuthorizeError>({
          actorId: options.actorId ?? null,
          doing: operation.doing(input),
          id,
          initiator,
          locks,
          name: operation.kind,
          // Recorded once its lanes are its, checked again first if it
          // waited for them, then held until it ends.
          run: (waited) =>
            (waited ? authorize : Effect.void).pipe(
              Effect.andThen(start),
              Effect.tap((recorded) => Deferred.succeed(started, recorded.id)),
              Effect.andThen((recorded) => awaitOperationEnd(recorded.id)),
              Effect.provideContext(services)
            ),
          waitUntil,
        })
        // A caller that gives up while it waits withdraws it, set before it can
        // give up; once it's recorded, it goes on.
        return yield* restore(
          Effect.raceFirst(
            Deferred.await(started),
            Fiber.join(holder.fiber).pipe(
              Effect.andThen(
                Effect.die("The operation ended before it was recorded")
              )
            )
          )
        ).pipe(Effect.onInterrupt(() => Effect.sync(holder.withdraw)))
      })
    )
  }).pipe(Effect.withSpan("Operations.start"))

/**
 * Queues a durable operation for Hearth to run: recorded now, waiting, so
 * it outlives a restart, and its ID returned at once. It takes its turn in
 * its lanes as Hearth's own work once startup has taken back what's
 * running, however long its turn takes, then starts. Who asked is checked
 * first, by `authorize`, the request's own check, or the definition's,
 * before an idempotency key can hand back an operation, and again by the
 * definition's once its turn comes, ending it failed if they may no longer.
 * With `again`, a key whose operation failed queues a new one.
 */
export const queueDurableOperation = <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  R,
  AuthorizeError = never,
>(
  operation: DurableOperation<Input, Success, Failure, R>,
  input: Input["Type"],
  options: {
    readonly actorId?: string | null
    readonly again?: boolean
    readonly authorize?: Effect.Effect<void, AuthorizeError, Database>
    readonly idempotencyKey?: string
  } = {}
): Effect.Effect<string, unknown, Database> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("operation.name", operation.kind)
    const actorId = options.actorId ?? null
    const recheck =
      actorId && operation.authorize
        ? operation.authorize(input, actorId)
        : undefined
    yield* options.authorize ?? recheck ?? Effect.void
    if (options.idempotencyKey !== undefined) {
      const found = yield* findOperation(operation.kind, options.idempotencyKey)
      if (found && !(options.again && endedBadly(found.state))) return found.id
      if (found) yield* releaseIdempotencyKey(found.id)
    }
    const encoded = yield* Schema.encodeUnknownEffect(
      Schema.toCodecJson(operation.input)
    )(input).pipe(Effect.orDie) as Effect.Effect<unknown>
    const locks = withWholes(operation.locks(input))
    const services = yield* Effect.context<Database>()
    // Recorded and set to take its turn in one step that can't be cut off,
    // so none is left recorded with nothing to start it.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const recorded = yield* recordOperation({
          actorId,
          idempotencyKey: options.idempotencyKey,
          input: encoded,
          kind: operation.kind,
          locks,
          state: "waiting",
          version: operation.version,
        })
        yield* Effect.annotateCurrentSpan("operation.id", recorded.id)
        if (!recorded.existing) {
          yield* lanesOpen.pipe(
            Effect.andThen(
              takeTurn({
                actorId,
                doing: operation.doing(input),
                id: recorded.id,
                locks,
                name: operation.kind,
                recheck,
              })
            ),
            Effect.provideContext(services),
            Effect.forkDetach
          )
        }
        return recorded.id
      })
    )
  }).pipe(Effect.withSpan("Operations.queue"))

// Ended without going through, so its key may queue another.
const endedBadly = (state: string) =>
  state === "failed" || state === "interrupted" || state === "cancelled"

// A waiting operation taking its turn: held in its lanes as Hearth's own
// work, then started, its workflow run once its locks are its. Who asked is
// checked again just before it starts, however it got its turn.
const takeTurn = (waiting: {
  readonly actorId: string | null
  readonly doing: string
  readonly id: string
  readonly locks: ReadonlyArray<LaneLock>
  readonly name: string
  readonly recheck: Effect.Effect<void, unknown, Database> | undefined
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Database>()
    const start = () =>
      Effect.gen(function* () {
        if (waiting.recheck) {
          const allowed = yield* Effect.exit(waiting.recheck)
          if (allowed._tag === "Failure") {
            const failure = Cause.squash(allowed.cause)
            return yield* finishOperation(
              waiting.id,
              "failed",
              failure instanceof Error ? failure.message : String(failure)
            ).pipe(Effect.retry({ schedule: whileMySqlIsAway }))
          }
        }
        // Held until MySQL answers, so its turn isn't given up meanwhile.
        const started = yield* startWaitingOperation(waiting.id).pipe(
          Effect.retry({ schedule: whileMySqlIsAway })
        )
        if (!started) return
        yield* dispatchSoon(waiting.id)
        yield* awaitOperationEnd(waiting.id)
      }).pipe(Effect.provideContext(services))
    if (waiting.locks.length === 0) {
      yield* start().pipe(Effect.forkDetach)
      return
    }
    yield* holdLanes({
      actorId: waiting.actorId,
      doing: waiting.doing,
      id: waiting.id,
      initiator: "system",
      locks: waiting.locks,
      name: waiting.name,
      run: start,
      waitUntil: Number.MAX_SAFE_INTEGER,
    })
  })

/**
 * Sets every waiting operation not already in its lanes taking its turn,
 * in the order they were queued: at startup, behind what's running, and
 * every so often, for one whose turn was cut off, as when MySQL failed as
 * it was taken. Who asked is checked first.
 */
export const readmitWaitingOperations = Effect.gen(function* () {
  for (const operation of yield* waitingOperations()) {
    if ([...laneOccupants.values()].some((held) => held.id === operation.id)) {
      continue
    }
    const definition = [...durableKinds.values()].find(
      (kind) => kind.kind === operation.kind
    )
    const input = definition
      ? Schema.decodeUnknownOption(
          Schema.toCodecJson(
            definition.input
          ) as unknown as Schema.Codec<unknown>
        )(operation.input)
      : Option.none()
    const known = definition && Option.isSome(input) ? input.value : null
    yield* takeTurn({
      actorId: operation.actorId,
      doing: known !== null ? definition!.doing(known) : "Another change",
      id: operation.id,
      locks: withWholes(
        known !== null ? definition!.locks(known) : operation.locks
      ),
      name: operation.kind,
      recheck:
        known !== null && operation.actorId && definition!.authorize
          ? definition!.authorize(known, operation.actorId)
          : undefined,
    })
  }
})

// Starts the workflow off the caller's fiber, where the engine runs: all of
// Hearth, though not every test.
const dispatchSoon = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* Effect.serviceOption(OperationsEngineService)
    if (Option.isNone(engine)) return
    yield* dispatchDurableOperations([id]).pipe(
      Effect.provideService(OperationsEngineService, engine.value),
      Effect.forkDetach
    )
  })

// Takes a durable operation's lanes and holds them in a fiber of its own
// while `run` does, returning that fiber; a refusal fails it.
const holdLanes = <E>(hold: {
  readonly actorId: string | null
  readonly doing: string
  readonly id: string
  readonly initiator: Initiator
  readonly locks: ReadonlyArray<LaneLock>
  readonly name: string
  readonly run: (waited: boolean) => Effect.Effect<unknown, E>
  readonly waitUntil: number
}): Effect.Effect<{
  readonly fiber: Fiber.Fiber<unknown, E | OperationBusyError>
  readonly withdraw: () => void
}> =>
  Effect.gen(function* () {
    const label = `${hold.name}#${hold.id}`
    const ticket = hearthLanes.admit({
      label,
      locks: hold.locks,
      whenBusy: hold.initiator === "person" ? personWhenBusy : "wait",
    })
    occupy(label, {
      actorId: hold.actorId,
      admittedAt: Date.now(),
      doing: hold.doing,
      durable: true,
      id: hold.id,
      initiator: hold.initiator,
      name: hold.name,
      startedAt: Date.now(),
    })
    const fiber = yield* awaitTurn(
      ticket.run(Effect.suspend(() => hold.run(!ticket.grantedAtOnce))),
      {
        initiator: hold.initiator,
        label,
        name: hold.name,
        onRefused: Effect.void,
        ticket: () => ticket,
        waitUntil: hold.waitUntil,
      }
    ).pipe(Effect.ensuring(vacate(label)), Effect.forkDetach)
    return { fiber, withdraw: ticket.cancel }
  }).pipe(
    // Admitted, noted, and its holder forked, in one step that can't be cut
    // off: none can be left holding a place in line with nothing to end it.
    Effect.uninterruptible
  )

/**
 * Takes back the locks of every durable operation a previous Hearth left
 * running, before anything else is admitted, and holds them until each
 * ends.
 */
export const restoreLockingOperations = Effect.gen(function* () {
  const services = yield* Effect.context<Database>()
  const running = yield* runningOperations()
  let restored = 0
  for (const operation of running) {
    const definition = [...durableKinds.values()].find(
      (kind) => kind.kind === operation.kind
    )
    const input = definition
      ? Schema.decodeUnknownOption(
          Schema.toCodecJson(
            definition.input
          ) as unknown as Schema.Codec<unknown>
        )(operation.input)
      : Option.none()
    // Its definition's locks, or those it was recorded with when this
    // Hearth no longer knows the kind.
    const locks = withWholes(
      definition && Option.isSome(input)
        ? definition.locks(input.value)
        : operation.locks
    )
    if (locks.length === 0) continue
    yield* holdLanes({
      actorId: operation.actorId,
      doing:
        definition && Option.isSome(input)
          ? definition.doing(input.value)
          : "Another change",
      id: operation.id,
      initiator: "system",
      locks,
      name: operation.kind,
      run: () =>
        awaitOperationEnd(operation.id).pipe(Effect.provideContext(services)),
      waitUntil: Number.MAX_SAFE_INTEGER,
    })
    restored++
  }
  // Those waiting their turn take it again, in the order they were queued,
  // behind what's running.
  yield* readmitWaitingOperations
  yield* Effect.annotateCurrentSpan("operations.restored", restored)
}).pipe(Effect.withSpan("Operations.restore"))

/**
 * Starts the workflow of each running durable operation. A workflow already
 * started for it is found by the operation's ID, so starting again after a
 * restart is harmless.
 */
export const dispatchDurableOperations = (
  ids: ReadonlyArray<string>
): Effect.Effect<void, never, Database | OperationsEngineService> =>
  Effect.forEach(ids, (id) => dispatch(id), { discard: true })

const dispatch = Effect.fnUntraced(
  function* (id: string) {
    const record = yield* loadOperation(id).pipe(Effect.orDie)
    if (record?.state !== "running") return
    const operation = durableKinds.get(`${record.kind}@${record.version}`)
    if (!operation) {
      return yield* finishOperation(
        id,
        "failed",
        `This Hearth can't run ${record.kind} version ${record.version}`
      ).pipe(Effect.orDie)
    }
    // Its payload is just the operation's ID, and a discarded run decodes no
    // result, so starting it needs nothing but the engine.
    const execute = operation.workflow.execute(
      { operationId: id },
      { discard: true }
    ) as Effect.Effect<string, never, WorkflowEngine.WorkflowEngine>
    const executionId = yield* withOperationsEngine(execute).pipe(Effect.orDie)
    yield* recordExecution(id, executionId).pipe(Effect.orDie)
  },
  (effect, id) =>
    effect.pipe(
      Effect.withSpan("Operations.dispatch", {
        attributes: { "operation.id": id },
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Operation ${id} didn't start`, cause)
      )
    )
)

/**
 * Tries a write of the operation's own again until MySQL answers, backing
 * off to every 30 seconds.
 */
export const whileMySqlIsAway = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
])

export function outcomeOf(exit: Exit.Exit<unknown, unknown>): OperationOutcome {
  if (Exit.isSuccess(exit)) return "succeeded"
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed"
}

export function errorOf(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

// A step's own reads and writes of the operation are tried again until
// MySQL answers (`whileMySqlIsAway`): a step that failed for it would end
// the workflow for good with the operation's locks still held.

const loadInput = <Input extends Schema.Top>(schema: Input, id: string) =>
  Effect.gen(function* () {
    const record = yield* loadOperation(id).pipe(
      Effect.retry({ schedule: whileMySqlIsAway }),
      Effect.orDie
    )
    if (!record) return yield* Effect.die(`Operation ${id} is gone`)
    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(
      record.input
    ).pipe(Effect.orDie)
  }) as Effect.Effect<
    Input["Type"],
    never,
    Database | Input["DecodingServices"]
  >

function linkTo(trace: {
  readonly sampled: boolean
  readonly spanId: string
  readonly traceId: string
}): Tracer.SpanLink {
  return {
    attributes: {},
    span: Tracer.externalSpan({
      sampled: trace.sampled,
      spanId: trace.spanId,
      traceId: trace.traceId,
    }),
  }
}
