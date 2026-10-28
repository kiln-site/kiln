// A Hearth that starts a move and never lets its copy finish, for a test to
// kill mid-step. Tells its parent `{ executionId }` once the move is
// accepted, and `{ step }` as each step starts.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Layer } from "effect"

import { databaseClientConfig } from "@/effect/database"

import { OperationsEngine } from "../engine"
import { Move, moveHandler } from "./move-workflow"

const runs = new Map<string, number>()

const Engine = moveHandler({
  copied: Effect.never,
  step: (name) =>
    Effect.sync(() => {
      runs.set(name, (runs.get(name) ?? 0) + 1)
      process.send?.({ step: name })
      return runs.get(name) ?? 0
    }),
}).pipe(
  Layer.provideMerge(OperationsEngine),
  Layer.provide(MysqlClient.layer(databaseClientConfig(4)))
)

Effect.gen(function* () {
  const executionId = yield* Move.execute(
    { id: process.env.MOVE_ID ?? "move" },
    { discard: true }
  )
  process.send?.({ executionId })
  return yield* Effect.never
}).pipe(Effect.provide(Engine), Effect.runFork)
