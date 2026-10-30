import type { AsyncLocalStorage } from "node:async_hooks"

import type { LaneLock } from "@workspace/operations"
import { Context, Effect } from "effect"

/** Who an operation's lanes turn away and who they keep waiting. */
export type Initiator = "person" | "system"

/** The operation an effect runs in, if any, and the locks it holds. */
export interface RunningOperation {
  readonly id: string
  readonly name: string
  readonly initiator: Initiator
  /** Every lock it and the operations it runs inside hold. */
  readonly held: ReadonlyArray<LaneLock>
}

export const CurrentOperation = Context.Reference<RunningOperation | null>(
  "Operations/CurrentOperation",
  { defaultValue: () => null }
)

// The operation promise code runs for, across the bridges between Effect
// and promises (`promiseEffect` out, `runAppEffect` back in), so work an
// operation reaches through promise code still runs inside it rather than
// waiting for it. Created on first use: the browser shares `promiseEffect`
// and runs no operations.
let storage: AsyncLocalStorage<RunningOperation> | undefined
const operationStorage = () =>
  (storage ??= new (process.getBuiltinModule(
    "node:async_hooks"
  ).AsyncLocalStorage)<RunningOperation>())

// Operations whose work is running now. Promise code an operation started
// that outlives it, such as a timer, starts its effects on their own.
const running = new Set<string>()

/** Marks `effect` as an operation's work while it runs. */
export const runningAs = <A, E, R>(
  operation: RunningOperation,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => running.add(operation.id)),
    () => Effect.provideService(effect, CurrentOperation, operation),
    () => Effect.sync(() => running.delete(operation.id))
  )

/** Runs promise code as part of the current operation, if there is one. */
export const withCurrentOperation = <A>(
  run: () => PromiseLike<A>
): Effect.Effect<() => PromiseLike<A>> =>
  Effect.gen(function* () {
    const operation = yield* CurrentOperation
    return operation ? () => operationStorage().run(operation, run) : run
  })

/** Gives an effect started from promise code the operation it runs for. */
export const inCurrentOperation = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const operation = storage?.getStore()
  return operation && running.has(operation.id)
    ? Effect.provideService(effect, CurrentOperation, operation)
    : effect
}
