/**
 * Hearth's record of its durable operations (docs/hearth-operations.md):
 * one row each, written as it starts and as it ends, for its workflow to
 * read its input from, for restarts to find what didn't end, and for the
 * operator to see.
 */
import { randomUUID } from "node:crypto"

import type { LaneLock } from "@workspace/operations"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Deferred, Duration, Effect, Metric, Option } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { operationsTablePrefix } from "@/operations/engine"
import { publishOperationsChange } from "@/operations/realtime"

export type OperationState =
  | "cancelled"
  | "failed"
  | "interrupted"
  | "running"
  | "succeeded"
  /** Recorded, and waiting its turn in its lanes. */
  | "waiting"

export type OperationOutcome = Exclude<OperationState, "running" | "waiting">

const operationTable = databaseTable("operation")

const finished = Metric.counter("hearth.operations.finished", {
  description: "Operations that ended, by how they ended",
  attributes: { unit: "{operation}" },
  incremental: true,
})

const runDuration = Metric.histogram("hearth.operations.duration", {
  description: "Time from starting an operation until it ended",
  attributes: { unit: "s" },
  boundaries: [
    0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800, 3600, 21_600,
    86_400,
  ],
})

/**
 * Records a durable operation as running, or waiting its turn. With an
 * idempotency key, one already recorded under it is returned instead,
 * however it went.
 */
export const recordOperation = Effect.fn("Operations.record")(
  function* (record: {
    readonly kind: string
    readonly version: number
    /** The encoded input its workflow reads. */
    readonly input: unknown
    readonly idempotencyKey?: string | undefined
    readonly actorId?: string | null | undefined
    /** Chosen before it's recorded, as when its lanes were taken first. */
    readonly id?: string | undefined
    /** The locks it holds until it ends. */
    readonly locks?: ReadonlyArray<LaneLock> | undefined
    /** Waiting, for one recorded before its turn comes. */
    readonly state?: "running" | "waiting"
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const span = yield* Effect.option(Effect.currentSpan)
    const id = record.id ?? randomUUID()
    const inserted = yield* database.execute(
      "operations.record",
      `INSERT ${record.idempotencyKey === undefined ? "" : "IGNORE"}
       INTO ${operationTable}
       (id, kind, version, idempotency_key, input, locks, state, actor_id,
        trace_id, span_id, trace_sampled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.kind,
        record.version,
        record.idempotencyKey ?? null,
        JSON.stringify(record.input ?? null),
        record.locks?.length ? JSON.stringify(record.locks) : null,
        record.state ?? "running",
        record.actorId ?? null,
        Option.isSome(span) ? span.value.traceId : null,
        Option.isSome(span) ? span.value.spanId : null,
        Option.isSome(span) ? span.value.sampled : false,
        now,
        now,
      ]
    )
    if (inserted.affectedRows === 0) {
      const [found] = yield* database.queryRows<RowDataPacket & { id: string }>(
        "operations.record",
        `SELECT id FROM ${operationTable}
        WHERE kind = ? AND idempotency_key = ?`,
        [record.kind, record.idempotencyKey ?? null]
      )
      if (!found) return yield* Effect.die("The operation's row went missing")
      yield* Effect.annotateCurrentSpan("operation.id", found.id)
      return { existing: true, id: found.id }
    }
    yield* Effect.annotateCurrentSpan({
      "operation.id": id,
      "operation.kind": record.kind,
    })
    publishOperationsChange()
    return { existing: false, id }
  }
)

/** Records the workflow an operation runs as, for its history's retention. */
export const recordExecution = Effect.fnUntraced(function* (
  id: string,
  executionId: string
) {
  const database = yield* Database
  yield* database.execute(
    "operations.execution",
    `UPDATE ${operationTable} SET execution_id = ?
      WHERE id = ? AND execution_id IS NULL`,
    [executionId, id]
  )
})

/** Records how an operation ended. Ending one already ended changes nothing. */
export const finishOperation = Effect.fn("Operations.finish")(function* (
  id: string,
  outcome: OperationOutcome,
  error?: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const [row] = yield* database.queryRows<
    RowDataPacket & { created_at: number; kind: string }
  >(
    "operations.finish",
    `SELECT kind, created_at FROM ${operationTable}
      WHERE id = ? AND state IN ('running', 'waiting')`,
    [id]
  )
  if (!row) return
  const ended = yield* database.execute(
    "operations.finish",
    `UPDATE ${operationTable}
        SET state = ?, error = ?, finished_at = ?, updated_at = ?,
            queue_key = NULL
      WHERE id = ? AND state IN ('running', 'waiting')`,
    [outcome, error?.slice(0, 1024) ?? null, now, now, id]
  )
  if (ended.affectedRows === 0) return
  yield* endedHere(id)
  const kind = { "operation.kind": row.kind }
  yield* Metric.update(
    Metric.withAttributes(finished, { ...kind, "operation.outcome": outcome }),
    1
  )
  yield* Metric.update(
    Metric.withAttributes(runDuration, kind),
    (now - Number(row.created_at)) / 1000
  )
  publishOperationsChange()
})

/** The operation recorded under an idempotency key, if any. */
export const findOperation = Effect.fnUntraced(function* (
  kind: string,
  idempotencyKey: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { id: string; state: OperationState }
  >(
    "operations.find",
    `SELECT id, state FROM ${operationTable}
      WHERE kind = ? AND idempotency_key = ?`,
    [kind, idempotencyKey]
  )
  return row ? { id: row.id, state: row.state } : null
})

// Operations of this process waiting for one to end, woken as it does.
const endings = ((
  globalThis as typeof globalThis & {
    kilnOperationEndings?: Map<string, Deferred.Deferred<void>>
  }
).kilnOperationEndings ??= new Map<string, Deferred.Deferred<void>>())

const endedHere = (id: string) =>
  Effect.suspend(() => {
    const ending = endings.get(id)
    endings.delete(id)
    return ending ? Deferred.succeed(ending, undefined) : Effect.void
  })

// How often one waiting for an operation to end looks for itself, in case
// it ended some other way, such as by a migration.
const ENDED_CHECK = "30 seconds"

/** Waits until an operation is no longer running. */
export const awaitOperationEnd = (
  id: string
): Effect.Effect<void, never, Database> =>
  Effect.gen(function* () {
    let ending = endings.get(id)
    if (!ending) {
      ending = yield* Deferred.make<void>()
      endings.set(id, ending)
    }
    const stillRunning: Effect.Effect<boolean, never, Database> = Effect.gen(
      function* () {
        const record = yield* loadOperation(id).pipe(
          Effect.catch(() => Effect.succeed({ state: "running" as const }))
        )
        return record !== null && record.state === "running"
      }
    )
    const watch = Effect.gen(function* () {
      while (yield* stillRunning) yield* Effect.sleep(ENDED_CHECK)
    })
    yield* Effect.raceFirst(Deferred.await(ending), watch)
  })

/**
 * Starts an operation recorded waiting, now its turn has come, giving up
 * its queue key, so what's asked after it queues behind it. False if it
 * isn't waiting any more, as one cancelled meanwhile.
 */
export const startWaitingOperation = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const started = yield* database.execute(
    "operations.start",
    `UPDATE ${operationTable}
        SET state = 'running', updated_at = ?, queue_key = NULL
      WHERE id = ? AND state = 'waiting'`,
    [now, id]
  )
  if (started.affectedRows === 1) publishOperationsChange()
  return started.affectedRows === 1
})

/**
 * Records an operation waiting its turn under `key`, or joins the one
 * already waiting under it, its input made `join` of what it asked and
 * what's asked now. Joining locks the one waiting, as starting it does, so
 * an ask either joins it before it starts, and it runs what was joined, or
 * finds it started and queues another.
 */
export const queueOperation = Effect.fn("Operations.queue.record")(function* (
  record: {
    readonly kind: string
    readonly version: number
    readonly key: string
    /** The encoded input its workflow reads. */
    readonly input: unknown
    readonly locks: ReadonlyArray<LaneLock>
  },
  join: (waiting: unknown) => Effect.Effect<unknown>
) {
  const database = yield* Database
  // Each pass either records one, joins one, or finds the one it would
  // have joined just started; a few in a row means something else
  // refused the insert.
  for (let attempt = 0; ; attempt++) {
    if (attempt >= 5) {
      return yield* Effect.die(
        new Error(`Couldn't queue ${record.kind} under ${record.key}`)
      )
    }
    const now = yield* Clock.currentTimeMillis
    const span = yield* Effect.option(Effect.currentSpan)
    const id = randomUUID()
    const inserted = yield* database.execute(
      "operations.queue",
      `INSERT IGNORE INTO ${operationTable}
         (id, kind, version, queue_key, input, locks, state, trace_id,
          span_id, trace_sampled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`,
      [
        id,
        record.kind,
        record.version,
        record.key,
        JSON.stringify(record.input ?? null),
        record.locks.length ? JSON.stringify(record.locks) : null,
        Option.isSome(span) ? span.value.traceId : null,
        Option.isSome(span) ? span.value.spanId : null,
        Option.isSome(span) ? span.value.sampled : false,
        now,
        now,
      ]
    )
    if (inserted.affectedRows === 1) {
      publishOperationsChange()
      return { id, joined: false }
    }
    const joined = yield* database.transaction(
      "operations.queue.join",
      (transaction) =>
        Effect.gen(function* () {
          const [waiting] = yield* transaction.queryRows<
            RowDataPacket & { id: string; input: unknown }
          >(
            `SELECT id, input FROM ${operationTable}
                WHERE kind = ? AND queue_key = ?
                FOR UPDATE`,
            [record.kind, record.key]
          )
          if (!waiting) return null
          const input = yield* join(
            typeof waiting.input === "string"
              ? JSON.parse(waiting.input)
              : waiting.input
          )
          yield* transaction.execute(
            `UPDATE ${operationTable} SET input = ?, updated_at = ?
                WHERE id = ?`,
            [JSON.stringify(input ?? null), now, waiting.id]
          )
          return waiting.id
        })
    )
    // Started as it was asked: this one queues behind it.
    if (joined !== null) return { id: joined, joined: true }
  }
})

/**
 * Cancels an operation still waiting its turn, so it never starts. False
 * once it has.
 */
export const cancelWaitingOperation = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const cancelled = yield* database.execute(
    "operations.cancelWaiting",
    `UPDATE ${operationTable}
        SET state = 'cancelled', finished_at = ?, updated_at = ?,
            queue_key = NULL
      WHERE id = ? AND state = 'waiting'`,
    [now, now, id]
  )
  if (cancelled.affectedRows === 1) publishOperationsChange()
  return cancelled.affectedRows === 1
})

/** The operation of `kind` waiting under `key`, if one is. */
export const waitingOperation = Effect.fnUntraced(function* (
  kind: string,
  key: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { id: string; input: unknown }
  >(
    "operations.waitingByKey",
    `SELECT id, input FROM ${operationTable}
      WHERE kind = ? AND queue_key = ?`,
    [kind, key]
  )
  return row
    ? {
        id: row.id,
        input:
          typeof row.input === "string" ? JSON.parse(row.input) : row.input,
      }
    : null
})

/** Durable operations waiting their turn, oldest first, as for a restart. */
export const waitingOperations = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & {
      actor_id: string | null
      id: string
      input: unknown
      kind: string
      locks: unknown
    }
  >(
    "operations.waiting",
    `SELECT id, kind, actor_id, input, locks FROM ${operationTable}
      WHERE state = 'waiting'
      ORDER BY created_at`
  )
  return rows.map((row) => ({
    actorId: row.actor_id,
    id: row.id,
    input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
    kind: row.kind,
    locks: row.locks === null ? [] : parseLocks(row.locks),
  }))
})

/** Durable operations still running, oldest first, with what they hold. */
export const runningOperations = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & {
      actor_id: string | null
      created_at: number
      id: string
      input: unknown
      kind: string
      locks: unknown
    }
  >(
    "operations.running",
    `SELECT id, kind, actor_id, input, locks, created_at FROM ${operationTable}
      WHERE state = 'running'
      ORDER BY created_at`
  )
  return rows.map((row) => ({
    actorId: row.actor_id,
    createdAt: Number(row.created_at),
    id: row.id,
    input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
    kind: row.kind,
    locks: row.locks === null ? [] : parseLocks(row.locks),
  }))
})

function parseLocks(value: unknown): ReadonlyArray<LaneLock> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  return Array.isArray(parsed) ? (parsed as ReadonlyArray<LaneLock>) : []
}

/**
 * Operations running whose workflow wasn't started, oldest first. One that
 * started resumes with the engine.
 */
export const undispatchedOperations = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
    "operations.undispatched",
    `SELECT id FROM ${operationTable}
      WHERE state = 'running' AND execution_id IS NULL
      ORDER BY created_at`
  )
  return rows.map((row) => row.id)
})

const RETENTION_BATCH = 500

/**
 * Forgets operations that ended more than `age` ago, with their workflow
 * history: the engine's messages and replies for the workflow, its clock,
 * and its steps, all addressed by its execution ID. History goes first, so
 * one cut off is found again next time.
 */
export const forgetFinishedOperations = Effect.fn("Operations.retention")(
  function* (age: Duration.Input) {
    const database = yield* Database
    const cutoff =
      (yield* Clock.currentTimeMillis) -
      Duration.toMillis(Duration.fromInputUnsafe(age))
    const messages = `${operationsTablePrefix()}_messages`
    const replies = `${operationsTablePrefix()}_replies`
    let forgotten = 0
    while (true) {
      const rows = yield* database.queryRows<
        RowDataPacket & { execution_id: string | null; id: string }
      >(
        "operations.retention",
        `SELECT id, execution_id FROM ${operationTable}
          WHERE finished_at IS NOT NULL AND finished_at < ?
          ORDER BY finished_at
          LIMIT ${RETENTION_BATCH}`,
        [cutoff]
      )
      if (rows.length === 0) break
      const executions = rows.flatMap((row) =>
        row.execution_id ? [row.execution_id] : []
      )
      if (executions.length > 0) {
        yield* database.transaction("operations.retention", (transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute(
              `DELETE FROM ${replies} WHERE request_id IN (
                 SELECT id FROM ${messages}
                  WHERE entity_id IN (${placeholders(executions)})
               )`,
              executions
            )
            yield* transaction.execute(
              `DELETE FROM ${messages}
                WHERE entity_id IN (${placeholders(executions)})`,
              executions
            )
          })
        )
      }
      const ids = rows.map((row) => row.id)
      yield* database.execute(
        "operations.retention",
        `DELETE FROM ${operationTable} WHERE id IN (${placeholders(ids)})`,
        ids
      )
      forgotten += rows.length
      if (rows.length < RETENTION_BATCH) break
    }
    yield* Effect.annotateCurrentSpan("operations.forgotten", forgotten)
    return forgotten
  }
)

const placeholders = (values: ReadonlyArray<unknown>) =>
  values.map(() => "?").join(", ")

/** Kiln's tables of operations, for what copies the database to leave out. */
export const operationTables: ReadonlyArray<string> = [operationTable]

export interface OperationRecord {
  readonly actorId: string | null
  readonly error: string | null
  readonly id: string
  readonly input: unknown
  readonly kind: string
  /** The locks it holds until it ends. */
  readonly locks: ReadonlyArray<LaneLock>
  readonly state: OperationState
  /** The span that started it, for a run to link to. */
  readonly trace: {
    readonly sampled: boolean
    readonly spanId: string
    readonly traceId: string
  } | null
  readonly version: number
}

export const loadOperation = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & {
      actor_id: string | null
      error: string | null
      id: string
      input: unknown
      kind: string
      locks: unknown
      span_id: string | null
      state: OperationState
      trace_id: string | null
      trace_sampled: number
      version: number
    }
  >(
    "operations.load",
    `SELECT id, kind, version, input, locks, state, actor_id, error,
            trace_id, span_id, trace_sampled
       FROM ${operationTable} WHERE id = ?`,
    [id]
  )
  if (!row) return null
  return {
    actorId: row.actor_id,
    error: row.error,
    id: row.id,
    input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
    kind: row.kind,
    locks: row.locks === null ? [] : parseLocks(row.locks),
    state: row.state,
    trace:
      row.trace_id && row.span_id
        ? {
            sampled: Boolean(row.trace_sampled),
            spanId: row.span_id,
            traceId: row.trace_id,
          }
        : null,
    version: row.version,
  } satisfies OperationRecord
})
