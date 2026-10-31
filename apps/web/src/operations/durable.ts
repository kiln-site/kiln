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
  cancelWaitingOperation,
  queueOperation,
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
  /** What one waiting runs once more is asked of it under its key. */
  readonly join: (waiting: Input["Type"], asked: Input["Type"]) => Input["Type"]
  /** Whether one queued can start now its turn has come. */
  readonly ready: (
    input: Input["Type"]
  ) => Effect.Effect<boolean, never, Database>
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
   * What one queued under a key runs once more is asked of it while it
   * waits (`queueDurableOperation`): what it asked, by default.
   */
  readonly join?: (
    waiting: Input["Type"],
    asked: Input["Type"]
  ) => Input["Type"]
  /**
   * Whether one queued can start now its turn has come, as when what it
   * needs is there. One that can't gives its turn back and stays waiting,
   * so what's asked meanwhile still joins it and it can still be
   * cancelled; it's tried again within a minute. It answers from what its
   * key names, which joining doesn't change.
   */
  readonly ready?: (
    input: Input["Type"]
  ) => Effect.Effect<boolean, never, Database>
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
    doing: options.doing ?? (() => "Another change"),
    join: options.join ?? ((waiting) => waiting),
    ready: options.ready ?? (() => Effect.succeed(true)),
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
 * running, however long its turn takes, then starts. With a `key`, what's
 * asked while one waits under it joins that one, by its definition's
 * `join`, so asks made while the same work runs ahead make one run behind
 * it. A key names one change's work: what joins it takes its locks.
 */
export const queueDurableOperation = <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  R,
>(
  operation: DurableOperation<Input, Success, Failure, R>,
  input: Input["Type"],
  options: { readonly key?: string } = {}
): Effect.Effect<string, DatabaseError, Database> =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("operation.name", operation.kind)
    const codec = Schema.toCodecJson(
      operation.input
    ) as unknown as Schema.Codec<Input["Type"], unknown>
    const encode = (value: Input["Type"]) =>
      Schema.encodeUnknownEffect(codec)(value).pipe(
        Effect.orDie
      ) as Effect.Effect<unknown>
    const encoded = yield* encode(input)
    const locks = withWholes(operation.locks(input))
    const services = yield* Effect.context<Database>()
    const joining = (waiting: unknown) =>
      Schema.decodeUnknownEffect(codec)(waiting).pipe(
        Effect.orDie,
        Effect.flatMap((current) =>
          JSON.stringify(withWholes(operation.locks(current))) ===
          JSON.stringify(locks)
            ? encode(operation.join(current, input))
            : Effect.die(
                new Error(`${operation.kind} joined work of other locks`)
              )
        )
      )
    // Recorded and set to take its turn in one step that can't be cut off,
    // so none is left recorded with nothing to start it.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const queued =
          options.key === undefined
            ? {
                id: (yield* recordOperation({
                  input: encoded,
                  kind: operation.kind,
                  locks,
                  state: "waiting",
                  version: operation.version,
                })).id,
                joined: false,
              }
            : yield* queueOperation(
                {
                  input: encoded,
                  key: options.key,
                  kind: operation.kind,
                  locks,
                  version: operation.version,
                },
                joining
              )
        yield* Effect.annotateCurrentSpan("operation.id", queued.id)
        if (!queued.joined) {
          yield* lanesOpen.pipe(
            Effect.andThen(
              takeTurn({
                actorId: null,
                doing: operation.doing(input),
                id: queued.id,
                locks,
                name: operation.kind,
                ready: operation.ready(input),
              })
            ),
            Effect.provideContext(services),
            Effect.forkDetach
          )
        }
        return queued.id
      })
    )
  }).pipe(Effect.withSpan("Operations.queue"))

// A waiting operation taking its turn: held in its lanes as Hearth's own
// work, however long its turn takes, then started, its workflow run once
// its locks are its. One not ready gives its turn back, still waiting, for
// the sweep to take up again.
const takeTurn = (waiting: {
  readonly actorId: string | null
  readonly doing: string
  readonly id: string
  readonly locks: ReadonlyArray<LaneLock>
  readonly name: string
  readonly ready: Effect.Effect<boolean, never, Database>
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Database>()
    const start = () =>
      Effect.gen(function* () {
        if (!(yield* waiting.ready)) return
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
    const holder = yield* holdLanes({
      actorId: waiting.actorId,
      doing: waiting.doing,
      id: waiting.id,
      initiator: "system",
      locks: waiting.locks,
      name: waiting.name,
      run: () =>
        Effect.suspend(() => {
          // Its turn came: past withdrawing.
          queuedHolders.delete(waiting.id)
          return start()
        }),
      waitUntil: Number.MAX_SAFE_INTEGER,
    })
    queuedHolders.set(waiting.id, holder.withdraw)
    // Cancelled as it took its place, as by a sweep that read it waiting
    // just before: it leaves at once, since the cancel may have missed it.
    const now = yield* loadOperation(waiting.id).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
    if (now !== null && now.state !== "waiting") {
      queuedHolders.get(waiting.id)?.()
      queuedHolders.delete(waiting.id)
    }
  })

// The places in line of operations queued and not yet started, by ID, so
// one cancelled leaves the line at once rather than at its turn.
const queuedHolders = new Map<string, () => void>()

/**
 * Cancels a queued operation that hasn't started, so it never does, and
 * takes it out of its lanes' line. False once it has started.
 */
export const cancelQueuedOperation = Effect.fnUntraced(function* (id: string) {
  const cancelled = yield* cancelWaitingOperation(id)
  if (cancelled) {
    queuedHolders.get(id)?.()
    queuedHolders.delete(id)
  }
  return cancelled
})

/**
 * Sets every waiting operation not already in its lanes taking its turn,
 * in the order they were queued: at startup, behind what's running, and
 * every so often, for one whose turn was cut off, as when MySQL failed as
 * it was taken.
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
      ready: known !== null ? definition!.ready(known) : Effect.succeed(true),
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
