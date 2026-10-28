import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Scope,
  ScopedCache,
} from "effect"
import { SqlClient } from "effect/sql"
import type { WorkflowEngine } from "effect/workflow"

import type { AppCache } from "@/effect/cache"
import { Database, DatabaseClient } from "@/effect/database"

import { OperationsEngine } from "./engine"

export class OperationsUnavailableError extends Schema.TaggedError<OperationsUnavailableError>()(
  "OperationsUnavailableError",
  { cause: Schema.Defect(), message: Schema.String }
) {}

/** The running engine, as the services operations need from it. */
export type OperationsEngineContext =
  Context.Context<WorkflowEngine.WorkflowEngine>

/**
 * Hearth's operations engine, built on first use from the process's MySQL
 * client and kept for the life of the runtime. Startup builds it at once, so
 * work a previous Hearth left unfinished resumes; a failed build is tried
 * again a second later.
 */
export class OperationsEngineService extends Context.Service<
  OperationsEngineService,
  {
    readonly engine: Effect.Effect<
      OperationsEngineContext,
      OperationsUnavailableError
    >
  }
>()("kiln/OperationsEngine") {}

// A development reload builds a new runtime without disposing the old one.
// The old engine would keep its shard locks and leave the new one idle, so
// a new engine closes the one before it.
const previous = globalThis as typeof globalThis & {
  kilnOperationsEngine?: Scope.Closeable
}

// An operation step in flight finishes rather than being cut off; shutdown
// waits for it this long before leaving it to the next Hearth. Closing can't
// be cut short, so it runs on its own fiber and is waited on.
const SHUTDOWN_GRACE = Duration.seconds(5)

const closeEngine = (scope: Scope.Closeable) =>
  Scope.close(scope, Exit.void).pipe(
    Effect.forkDetach,
    Effect.flatMap((closing) =>
      Fiber.await(closing).pipe(Effect.timeoutOption(SHUTDOWN_GRACE))
    ),
    Effect.asVoid
  )

export const OperationsEngineLive = Layer.effect(OperationsEngineService)(
  Effect.gen(function* () {
    const { client } = yield* DatabaseClient
    const services = yield* Effect.context<AppCache | Database>()
    const engines = yield* ScopedCache.makeWith({
      capacity: 1,
      lookup: () =>
        Effect.gen(function* () {
          const replaced = previous.kilnOperationsEngine
          if (replaced) yield* closeEngine(replaced)
          const sql = yield* client
          // Loaded here, not imported: the workflows reach most of Hearth,
          // which reaches the runtime this service is part of.
          const { HearthWorkflows } = yield* Effect.promise(
            () => import("./workflows")
          )
          const scope = yield* Scope.make()
          previous.kilnOperationsEngine = scope
          yield* Effect.addFinalizer(() => closeEngine(scope))
          return yield* Layer.buildWithScope(
            HearthWorkflows.pipe(
              Layer.provideMerge(OperationsEngine),
              Layer.provide(Layer.succeed(SqlClient.SqlClient)(sql)),
              Layer.provide(Layer.succeedContext(services))
            ),
            scope
          )
        }).pipe(Effect.withSpan("Operations.engine.start")),
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.seconds(1),
    })
    return {
      engine: ScopedCache.get(engines, "engine").pipe(
        Effect.mapError(
          (cause) =>
            new OperationsUnavailableError({
              cause,
              message: "Hearth's operations engine isn't running yet",
            })
        )
      ),
    }
  })
)

/** Runs `effect` with the operations engine. */
export const withOperationsEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(OperationsEngineService, ({ engine }) =>
    Effect.flatMap(engine, (context) => Effect.provide(effect, context))
  )
