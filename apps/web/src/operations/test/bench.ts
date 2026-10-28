// Measures the operations engine against the MySQL in DB_*: latency of a
// one-step workflow, throughput of many at once, what an idle engine costs
// MySQL, and what each run leaves stored. Run with
// `node --import tsx src/operations/test/bench.ts` from apps/web.
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Activity, Workflow } from "effect/workflow"

import { databaseClientConfig } from "@/effect/database"

import { OperationsEngine, operationsTablePrefix } from "../engine"

const Ping = Workflow.make("Operations.bench.ping", {
  idempotencyKey: ({ id }) => id,
  payload: { id: Schema.String },
  success: Schema.Number,
})

const PingLive = Ping.toLayer(() =>
  Activity.make({
    name: "ping",
    success: Schema.Number,
    execute: Effect.succeed(1),
  })
)

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const questions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ Value: string }>`
    SHOW GLOBAL STATUS LIKE 'Questions'`
  return Number(row?.Value ?? 0)
})

const idleRate = (seconds: number) =>
  Effect.gen(function* () {
    const before = yield* questions
    yield* Effect.sleep(`${seconds} seconds`)
    // Less the two status reads themselves.
    return ((yield* questions) - before - 2) / seconds
  })

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const run = `${Date.now()}`
  const serial: Array<number> = []
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now()
    yield* Ping.execute({ id: `${run}-serial-${index}` })
    serial.push(performance.now() - started)
  }
  serial.sort((left, right) => left - right)

  const started = performance.now()
  yield* Effect.forEach(
    Array.from({ length: 200 }, (_, index) => index),
    (index) => Ping.execute({ id: `${run}-parallel-${index}` }),
    { concurrency: "unbounded" }
  )
  const parallelMs = performance.now() - started

  const engineIdle = yield* idleRate(30)
  const [stored] = yield* sql<{ bytes: number; row_count: number }>`
    SELECT SUM(data_length + index_length) AS bytes, SUM(table_rows) AS row_count
      FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name LIKE ${`${operationsTablePrefix()}\\_%`}`
  return {
    engineIdleQueriesPerSecond: engineIdle,
    parallel200Ms: Math.round(parallelMs),
    serialMs: {
      p50: percentile(serial, 50)?.toFixed(1),
      p95: percentile(serial, 95)?.toFixed(1),
      p99: percentile(serial, 99)?.toFixed(1),
    },
    storedBytes: Number(stored?.bytes ?? 0),
    storedRows: Number(stored?.row_count ?? 0),
  }
})

const Database = MysqlClient.layer(databaseClientConfig(10))

Effect.gen(function* () {
  // What MySQL does without this engine, for comparison.
  const baselineIdle = yield* idleRate(30)
  const results = yield* program.pipe(
    Effect.provide(PingLive.pipe(Layer.provideMerge(OperationsEngine)))
  )
  console.log(JSON.stringify({ baselineIdle, ...results }, null, 2))
})
  .pipe(Effect.provide(Database), Effect.runPromise)
  .then(
    () => process.exit(0),
    (error) => {
      console.error(error)
      process.exit(1)
    }
  )
