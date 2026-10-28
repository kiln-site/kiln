// Measures what a blocked backlog in Hearth's lanes costs ordinary work:
// with N operations waiting behind one that holds a key, how long a quick
// operation on a key nothing else wants takes, start to end. Every decision
// to grant or release reads what's held and what waits, so it grows with
// the backlog. Run with `node --import tsx src/operations/test/lanes-bench.ts`
// from apps/web, against the MySQL in DB_* (DB_NAME is created and
// migrated if missing; use a throwaway one).
import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { exclusive } from "@workspace/operations"
import { Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"

import { Database, databaseClientConfig, makeDatabase } from "@/effect/database"
import { applyMigrations } from "@/effect/migrations"
import { databaseTable } from "@/lib/database-config"
import { migrations } from "@/migrations"

import { admitOperation } from "../lanes"
import { quickOperation, runOperation } from "../run"

const write = quickOperation<{ readonly key: string }>({
  kind: "bench.write",
  locks: ({ key }) => [exclusive(key)],
  version: 1,
})

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const empty = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`DELETE FROM ${databaseTable("operation")}`)
})

const backlog = (size: number) =>
  Effect.gen(function* () {
    yield* empty
    const admit = (key: string) =>
      admitOperation({
        durable: false,
        input: { key },
        kind: "bench.write",
        locks: [exclusive(key)],
        version: 1,
      })
    // The holder is granted at once; the rest wait behind it.
    yield* admit("hot")
    for (let index = 0; index < size; index += 1) yield* admit("hot")
    const timings: Array<number> = []
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now()
      yield* runOperation(write, { key: `free-${index}` }, Effect.void)
      timings.push(performance.now() - started)
    }
    timings.sort((left, right) => left - right)
    return {
      backlog: size,
      p50: percentile(timings, 50).toFixed(1),
      p95: percentile(timings, 95).toFixed(1),
      p99: percentile(timings, 99).toFixed(1),
    }
  })

const program = Effect.gen(function* () {
  const rows = []
  for (const size of [0, 100, 1_000, 5_000]) rows.push(yield* backlog(size))
  yield* empty
  console.table(rows)
})

const database = process.env.DB_NAME ?? "kiln_bench_lanes"
const config = { ...databaseClientConfig(4), database }
const Client = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* MysqlClient.make({ ...config, database: undefined })
    yield* sql`CREATE DATABASE IF NOT EXISTS ${sql(database)}`
    return MysqlClient.layer(config)
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer))
)
const Live = Layer.effect(
  Database,
  Effect.map(SqlClient.SqlClient, (sql) => makeDatabase(Effect.succeed(sql)))
).pipe(
  Layer.provideMerge(Layer.effectDiscard(applyMigrations(migrations))),
  Layer.provideMerge(Client)
)

Effect.runPromise(program.pipe(Effect.provide(Live))).then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
