import { Duration, Effect, Exit, Layer, Scope, ScopedCache } from "effect"
import { SqlClient } from "effect/sql"
import type { WorkflowEngine } from "effect/workflow"

import { Database } from "@/effect/database"

import { OperationsEngine } from "../engine"
import {
  OperationsEngineService,
  OperationsUnavailableError,
} from "../engine-service"

/**
 * An operations engine for tests, running `workflows` on the test database,
 * built on first use as Hearth's is.
 */
export const testOperationsEngine = (
  workflows: Layer.Layer<
    never,
    never,
    WorkflowEngine.WorkflowEngine | Database | OperationsEngineService
  >
) =>
  Layer.effect(OperationsEngineService)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Only the database: the suite's context also holds its TestClock,
      // which would stop the engine's waits and retries.
      const database = yield* Database
      let service: OperationsEngineService["Service"] | undefined
      const engines = yield* ScopedCache.makeWith({
        capacity: 1,
        lookup: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() =>
              Scope.close(scope, Exit.void).pipe(
                Effect.timeoutOption("5 seconds")
              )
            )
            return yield* Layer.buildWithScope(
              workflows.pipe(
                Layer.provideMerge(OperationsEngine),
                Layer.provide(Layer.succeed(SqlClient.SqlClient)(sql)),
                Layer.provide(Layer.succeed(Database)(database)),
                Layer.provide(
                  Layer.sync(OperationsEngineService)(() => service!)
                )
              ),
              scope
            )
          }),
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
      })
      service = OperationsEngineService.of({
        engine: ScopedCache.get(engines, "engine").pipe(
          Effect.mapError(
            (cause) =>
              new OperationsUnavailableError({
                cause,
                message: "The test engine didn't start",
              })
          )
        ),
      })
      return service
    })
  )
