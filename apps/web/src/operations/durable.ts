import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Tracer,
} from "effect"
import { Activity, Workflow, WorkflowEngine } from "effect/workflow"

import { Database } from "@/effect/database"

import { OperationsEngineService, withOperationsEngine } from "./engine-service"
import {
  finishOperation,
  loadOperation,
  recordExecution,
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

/** The durable operation an effect runs as a step of, if any. */
export const CurrentOperation = Context.Reference<{
  readonly id: string
  readonly kind: string
} | null>("Operations/CurrentOperation", { defaultValue: () => null })

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
          Effect.provideService(CurrentOperation, {
            id: operationId,
            kind: options.kind,
          }),
          Effect.withSpan("Operations.run", {
            attributes: {
              "operation.id": operationId,
              "operation.kind": options.kind,
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
    input: options.input,
    kind: options.kind,
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
 * Records a durable operation and starts its workflow, returning its ID.
 * With an idempotency key, starting it again returns the same operation.
 * Should the workflow not start, as while the engine can't, the operation
 * stays recorded and startup's sweep starts it.
 */
export const startDurableOperation = Effect.fn("Operations.start")(function* <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  R,
>(
  operation: DurableOperation<Input, Success, Failure, R>,
  input: Input["Type"],
  options: {
    readonly actorId?: string | null
    readonly idempotencyKey?: string
  } = {}
) {
  const encoded = yield* Schema.encodeUnknownEffect(
    Schema.toCodecJson(operation.input)
  )(input).pipe(Effect.orDie)
  const recorded = yield* recordOperation({
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
    input: encoded,
    kind: operation.kind,
    version: operation.version,
  })
  // Started off the caller's fiber, where the engine runs: all of Hearth,
  // though not every test.
  const engine = yield* Effect.serviceOption(OperationsEngineService)
  if (Option.isSome(engine)) {
    yield* dispatchDurableOperations([recorded.id]).pipe(
      Effect.provideService(OperationsEngineService, engine.value),
      Effect.forkDetach
    )
  }
  return recorded.id
})

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
