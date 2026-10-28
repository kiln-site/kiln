/**
 * Hearth's operation lanes, kept in MySQL (docs/hearth-operations-plan.md).
 *
 * An operation is admitted with the locks it needs and takes its place in
 * line; the lane rule shared with the Relays (`selectGrants`) decides when
 * it may start. Every decision to grant or release locks runs in one short
 * transaction that locks the scheduler row, so decisions are serial and
 * survive a restart: who waits, who holds what, and in what order.
 */
import { createHash, randomUUID } from "node:crypto"

import {
  LockTable,
  normalizeLocks,
  selectGrants,
  type LaneLock,
  type LaneMode,
} from "@workspace/operations"
import type { RowDataPacket } from "mysql2/promise"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Metric,
  Option,
  Schema,
} from "effect"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { operationsTablePrefix } from "@/operations/engine"
import { databaseTable } from "@/lib/database-config"

// A development reload loads this module again in the same process, whose
// operations are still running; the process keeps one ID.
const processIds = globalThis as typeof globalThis & {
  kilnHearthDriverId?: string
}

/** This Hearth process, as the driver of the operations it admits. */
export const hearthDriverId = (processIds.kilnHearthDriverId ??= randomUUID())

export type OperationState =
  | "cancelled"
  | "failed"
  | "granted"
  | "interrupted"
  | "running"
  | "succeeded"
  | "waiting"

export type OperationOutcome = Extract<
  OperationState,
  "cancelled" | "failed" | "interrupted" | "succeeded"
>

export interface Admission {
  readonly kind: string
  readonly version: number
  /** Runs as a workflow that survives a restart. */
  readonly durable: boolean
  readonly locks: ReadonlyArray<LaneLock>
  /** The encoded input, stored with the operation. */
  readonly input: unknown
  /** One accepted intent: admitting it again returns the same operation. */
  readonly idempotencyKey?: string | undefined
  readonly actorId?: string | null | undefined
  /**
   * The operation's ID, chosen before it's admitted, so a caller whose
   * admission might have committed without its answer can still end it.
   */
  readonly id?: string | undefined
}

export interface Admitted {
  readonly id: string
  /** Whether this admission found the operation already admitted. */
  readonly existing: boolean
}

export class OperationConflictError extends Schema.TaggedError<OperationConflictError>()(
  "OperationConflictError",
  { message: Schema.String }
) {}

export class OperationEndedError extends Schema.TaggedError<OperationEndedError>()(
  "OperationEndedError",
  { message: Schema.String, state: Schema.String }
) {}

const operationTable = databaseTable("operation")
const lockTable = databaseTable("operation_lock")
const schedulerTable = databaseTable("operation_scheduler")
const driverTable = databaseTable("operation_driver")

const admitted = Metric.counter("hearth.operations.admitted", {
  description: "Operations admitted to Hearth's lanes",
  attributes: { unit: "{operation}" },
  incremental: true,
})

const finished = Metric.counter("hearth.operations.finished", {
  description: "Operations that ended, by how they ended",
  attributes: { unit: "{operation}" },
  incremental: true,
})

const durationBoundaries = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800,
  3600,
]

const waitDuration = Metric.histogram("hearth.operations.wait.duration", {
  description: "Time from admitting an operation until its locks were granted",
  attributes: { unit: "s" },
  boundaries: durationBoundaries,
})

const holdDuration = Metric.histogram("hearth.operations.hold.duration", {
  description: "Time an operation held its locks, from grant to release",
  attributes: { unit: "s" },
  boundaries: durationBoundaries,
})

// Operations of this process waiting for their grant; a decision that
// grants one wakes it.
const waiters = new Map<string, Deferred.Deferred<void>>()
type GrantedHandler = (
  ids: ReadonlyArray<string>
) => Effect.Effect<void, never, Database>

// Called with operations a decision granted, such as to start a durable
// operation's workflow. Set once by the durable side.
let onGranted: GrantedHandler = () => Effect.void

/** Has granted durable operations started, wherever a decision grants them. */
export function setGrantedHandler(handler: GrantedHandler): void {
  onGranted = handler
}

const announce = (granted: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const id of granted) {
      const waiter = waiters.get(id)
      if (waiter) yield* Deferred.succeed(waiter, undefined)
    }
    if (granted.length > 0) yield* onGranted(granted)
  })

/**
 * Admits an operation: stores it, its input, and its locks in line, and
 * grants whatever the lane rule allows now. With an idempotency key, an
 * operation already admitted under it is returned instead, unless its input
 * differs.
 */
export const admitOperation = Effect.fn("Operations.enqueue")(function* (
  admission: Admission
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const locks = normalizeLocks(admission.locks)
  const inputJson = JSON.stringify(admission.input ?? null)
  const inputHash = createHash("sha256")
    .update(`${admission.kind}@${admission.version}\n${inputJson}`)
    .digest("hex")
  const span = yield* Effect.option(Effect.currentSpan)
  const decision = yield* database.transaction(
    "operations.admit",
    (transaction) =>
      Effect.gen(function* () {
        const sequence = yield* takeSchedulerTurn(transaction)
        // This Hearth is known to be running before it holds anything, so
        // another doesn't take its work for want of a heartbeat.
        yield* transaction.execute(
          `INSERT IGNORE INTO ${driverTable} (id, started_at, heartbeat_at)
           VALUES (?, ?, ?)`,
          [hearthDriverId, now, now]
        )
        if (admission.idempotencyKey !== undefined) {
          const [found] = yield* transaction.queryRows<
            RowDataPacket & { id: string; input_hash: string }
          >(
            `SELECT id, input_hash FROM ${operationTable}
              WHERE kind = ? AND idempotency_key = ?`,
            [admission.kind, admission.idempotencyKey]
          )
          if (found) {
            if (found.input_hash !== inputHash) {
              return yield* new OperationConflictError({
                message: `${admission.kind} was already started with other input under this key`,
              })
            }
            return { admitted: { existing: true, id: found.id }, granted: [] }
          }
        }
        const id = admission.id ?? randomUUID()
        yield* transaction.execute(
          `INSERT INTO ${operationTable}
             (id, kind, version, durable, sequence, idempotency_key,
              input_hash, input, state, actor_id, driver, trace_id, span_id,
              trace_sampled, admitted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            admission.kind,
            admission.version,
            admission.durable,
            sequence,
            admission.idempotencyKey ?? null,
            inputHash,
            inputJson,
            admission.actorId ?? null,
            hearthDriverId,
            Option.isSome(span) ? span.value.traceId : null,
            Option.isSome(span) ? span.value.spanId : null,
            Option.isSome(span) ? span.value.sampled : false,
            now,
            now,
          ]
        )
        for (const lock of locks) {
          yield* transaction.execute(
            `INSERT INTO ${lockTable} (operation_id, lock_key, mode, held)
             VALUES (?, ?, ?, 0)`,
            [id, lock.key, lock.mode]
          )
        }
        const granted = yield* grantWaiting(transaction, now)
        return { admitted: { existing: false, id }, granted }
      })
  )
  yield* Effect.annotateCurrentSpan({
    "operation.id": decision.admitted.id,
    "operation.kind": admission.kind,
    "operation.locks": locks.length,
  })
  if (!decision.admitted.existing) {
    yield* Metric.update(
      Metric.withAttributes(admitted, { "operation.kind": admission.kind }),
      1
    )
  }
  yield* announce(decision.granted)
  return decision.admitted as Admitted
})

/**
 * Waits until an operation of this process is granted its locks. Fails if
 * it ended first, as one withdrawn or interrupted does.
 */
export const awaitGrant = Effect.fnUntraced(function* (id: string) {
  const waiter = yield* Deferred.make<void>()
  waiters.set(id, waiter)
  yield* Effect.gen(function* () {
    while (true) {
      const state = yield* loadState(id)
      if (state === "granted" || state === "running") return
      if (state !== "waiting") {
        return yield* new OperationEndedError({
          message: `The operation ended before it started (${state})`,
          state,
        })
      }
      // A wake answers at once; the check again covers a decision this
      // process didn't make.
      yield* Deferred.await(waiter).pipe(Effect.timeoutOption("2 seconds"))
    }
  }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(id))))
})

/** Marks a granted operation as running. */
export const startOperation = Effect.fnUntraced(function* (
  id: string,
  executionId?: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const started = yield* database.execute(
    "operations.start",
    `UPDATE ${operationTable}
        SET state = 'running', started_at = COALESCE(started_at, ?),
            execution_id = COALESCE(?, execution_id), updated_at = ?
      WHERE id = ? AND state IN ('granted', 'running')`,
    [now, executionId ?? null, now, id]
  )
  // Taken over since its grant, as from a Hearth thought stopped: it holds
  // nothing now, so it mustn't run.
  if (started.affectedRows === 0) {
    const state = yield* loadState(id)
    if (state !== "running") {
      return yield* new OperationEndedError({
        message: `The operation ended before it started (${state})`,
        state,
      })
    }
  }
})

/**
 * Ends an operation and releases its locks, then grants what that frees.
 * Ending one already ended changes nothing.
 */
export const finishOperation = Effect.fn("Operations.finish")(function* (
  id: string,
  outcome: OperationOutcome,
  error?: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const decision = yield* database.transaction(
    "operations.finish",
    (transaction) =>
      Effect.gen(function* () {
        yield* takeSchedulerTurn(transaction)
        const [row] = yield* transaction.queryRows<
          RowDataPacket & {
            admitted_at: number
            granted_at: number | null
            kind: string
            state: OperationState
          }
        >(
          `SELECT kind, state, admitted_at, granted_at FROM ${operationTable}
            WHERE id = ? FOR UPDATE`,
          [id]
        )
        if (!row || !isOpen(row.state)) {
          return { ended: null, granted: [] as ReadonlyArray<string> }
        }
        yield* transaction.execute(
          `UPDATE ${operationTable}
              SET state = ?, error = ?, finished_at = ?, updated_at = ?
            WHERE id = ?`,
          [outcome, error?.slice(0, 1024) ?? null, now, now, id]
        )
        yield* transaction.execute(
          `DELETE FROM ${lockTable} WHERE operation_id = ?`,
          [id]
        )
        return {
          ended: row,
          granted: yield* grantWaiting(transaction, now),
        }
      })
  )
  if (decision.ended) {
    const kind = { "operation.kind": decision.ended.kind }
    yield* Metric.update(
      Metric.withAttributes(finished, {
        ...kind,
        "operation.outcome": outcome,
      }),
      1
    )
    if (decision.ended.granted_at !== null) {
      yield* Metric.update(
        Metric.withAttributes(holdDuration, kind),
        (now - Number(decision.ended.granted_at)) / 1000
      )
    }
  }
  yield* announce(decision.granted)
})

// How long a Hearth's heartbeat may be silent before its work is taken
// from it, well past a slow query or a pause; and how often it beats.
// Silence can't prove a change already under way has stopped, as one whose
// Hearth lost MySQL mid-request; a running change is given longer, past
// any request's own timeouts, before what waits behind it goes ahead.
const DRIVER_LEASE_MS = 30_000
const RUNNING_LEASE_MS = 120_000
export const DRIVER_HEARTBEAT = Duration.seconds(10)

// The work of a Hearth whose heartbeat stopped: none in its table, or none
// within the lease.
const lapsedDriver = `(driver IS NULL OR NOT EXISTS (
  SELECT 1 FROM ${driverTable} live
   WHERE live.id = ${operationTable}.driver AND live.heartbeat_at >= ?))`

/** Says this Hearth is running, so the work it drives stays its own. */
export const heartbeatDriver = Effect.fnUntraced(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "operations.heartbeat",
    `INSERT INTO ${driverTable} (id, started_at, heartbeat_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE heartbeat_at = VALUES(heartbeat_at)`,
    [hearthDriverId, now, now]
  )
})

/** Says this Hearth has stopped, so the next one need not wait out its lease. */
export const retireDriver = Effect.fnUntraced(function* () {
  const database = yield* Database
  // Not while a change of its own is still open: a request mid-change at
  // shutdown keeps it, and its lease runs out instead.
  yield* database.execute(
    "operations.retire",
    `DELETE FROM ${driverTable}
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM ${operationTable}
         WHERE driver = ? AND durable = 0
           AND state IN ('waiting', 'granted', 'running'))`,
    [hearthDriverId, hearthDriverId]
  )
})

/**
 * Takes over the work of a Hearth whose heartbeat stopped, as one that
 * crashed or was stopped: an operation that ended with the request running
 * it, as any but a durable one does, is withdrawn if it was still waiting
 * and marked interrupted if it ran, freeing its locks. Durable operations it
 * was driving become this one's. A Hearth that is slow or cut off from MySQL
 * but still beating keeps its work; once its lease lapses, what it does
 * after can no longer end or grant anything.
 */
export const recoverOperations = Effect.fn("Operations.recover")(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const liveSince = now - DRIVER_LEASE_MS
  const runningLiveSince = now - RUNNING_LEASE_MS
  const decision = yield* database.transaction(
    "operations.recover",
    (transaction) =>
      Effect.gen(function* () {
        yield* takeSchedulerTurn(transaction)
        const orphans = yield* transaction.queryRows<
          RowDataPacket & { id: string; state: OperationState }
        >(
          `SELECT id, state FROM ${operationTable}
            WHERE durable = 0 AND (driver IS NULL OR driver <> ?)
              AND ((state IN ('waiting', 'granted') AND ${lapsedDriver})
                OR (state = 'running' AND ${lapsedDriver}))
            FOR UPDATE`,
          [hearthDriverId, liveSince, runningLiveSince]
        )
        for (const orphan of orphans) {
          const ran = orphan.state !== "waiting"
          yield* transaction.execute(
            `UPDATE ${operationTable}
                SET state = ?, error = ?, finished_at = ?, updated_at = ?
              WHERE id = ?`,
            [
              ran ? "interrupted" : "cancelled",
              ran
                ? "The Hearth running it stopped"
                : "The Hearth it waited in stopped",
              now,
              now,
              orphan.id,
            ]
          )
          yield* transaction.execute(
            `DELETE FROM ${lockTable} WHERE operation_id = ?`,
            [orphan.id]
          )
        }
        yield* transaction.execute(
          `UPDATE ${operationTable} SET driver = ?, updated_at = ?
            WHERE durable = 1 AND state IN ('granted', 'running')
              AND (driver IS NULL OR driver <> ?) AND ${lapsedDriver}`,
          [hearthDriverId, now, hearthDriverId, liveSince]
        )
        // Hearths long gone.
        yield* transaction.execute(
          `DELETE FROM ${driverTable} WHERE heartbeat_at < ?`,
          [now - Duration.toMillis(Duration.days(1))]
        )
        return {
          granted: yield* grantWaiting(transaction, now),
          recovered: orphans.length,
        }
      })
  )
  yield* Effect.annotateCurrentSpan({
    "operations.recovered": decision.recovered,
  })
  yield* announce(decision.granted)
})

/** Durable operations granted whose workflow hasn't started, oldest first. */
export const undispatchedOperations = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
    "operations.undispatched",
    `SELECT id FROM ${operationTable}
      WHERE durable = 1 AND state = 'granted'
      ORDER BY sequence`
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
export const operationTables: ReadonlyArray<string> = [
  operationTable,
  lockTable,
  schedulerTable,
  driverTable,
]

export interface OperationRecord {
  readonly actorId: string | null
  readonly durable: boolean
  readonly error: string | null
  readonly executionId: string | null
  readonly id: string
  readonly input: unknown
  readonly kind: string
  readonly state: OperationState
  /** The span that admitted it, for a run to link to. */
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
      durable: number
      error: string | null
      execution_id: string | null
      id: string
      input: unknown
      kind: string
      span_id: string | null
      state: OperationState
      trace_id: string | null
      trace_sampled: number
      version: number
    }
  >(
    "operations.load",
    `SELECT id, kind, version, durable, input, state, actor_id,
            execution_id, error, trace_id, span_id, trace_sampled
       FROM ${operationTable} WHERE id = ?`,
    [id]
  )
  if (!row) return null
  return {
    actorId: row.actor_id,
    durable: Boolean(row.durable),
    error: row.error,
    executionId: row.execution_id,
    id: row.id,
    input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
    kind: row.kind,
    state: row.state,
    trace:
      row.trace_id && row.span_id
        ? {
            sampled: Boolean(row.trace_sampled),
            spanId: row.span_id,
            traceId: row.trace_id,
          }
        : null,
    version: Number(row.version),
  } satisfies OperationRecord
})

const loadState = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { state: OperationState }
  >("operations.state", `SELECT state FROM ${operationTable} WHERE id = ?`, [
    id,
  ])
  return row?.state ?? "cancelled"
})

function isOpen(state: OperationState): boolean {
  return state === "waiting" || state === "granted" || state === "running"
}

/**
 * Locks the scheduler row for this transaction, so decisions are made one at
 * a time, and returns the next place in line. The row is put back if a
 * database reset removed it.
 */
const takeSchedulerTurn = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction
) {
  const read = () =>
    transaction.queryRows<RowDataPacket & { next_sequence: number }>(
      `SELECT next_sequence FROM ${schedulerTable} WHERE id = 1 FOR UPDATE`
    )
  let [row] = yield* read()
  if (!row) {
    yield* transaction.execute(
      `INSERT IGNORE INTO ${schedulerTable} (id, next_sequence) VALUES (1, 1)`
    )
    ;[row] = yield* read()
  }
  const sequence = Number(row?.next_sequence ?? 1)
  yield* transaction.execute(
    `UPDATE ${schedulerTable} SET next_sequence = ? WHERE id = 1`,
    [sequence + 1]
  )
  return sequence
})

/**
 * Grants, in admission order, every waiting operation the lane rule allows,
 * inside the scheduler's transaction. Returns their IDs.
 */
const grantWaiting = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  now: number
) {
  const heldRows = yield* transaction.queryRows<
    RowDataPacket & { lock_key: string; mode: LaneMode }
  >(`SELECT lock_key, mode FROM ${lockTable} WHERE held = 1`)
  const held = new LockTable()
  held.take(heldRows.map((row) => ({ key: row.lock_key, mode: row.mode })))
  const waitingRows = yield* transaction.queryRows<
    RowDataPacket & {
      admitted_at: number
      id: string
      kind: string
      lock_key: string | null
      mode: LaneMode | null
    }
  >(
    `SELECT operation.id, operation.kind, operation.admitted_at,
            lock_row.lock_key, lock_row.mode
       FROM ${operationTable} operation
       LEFT JOIN ${lockTable} lock_row ON lock_row.operation_id = operation.id
      WHERE operation.state = 'waiting'
      ORDER BY operation.sequence, lock_row.lock_key`
  )
  const waiting: Array<{
    admittedAt: number
    id: string
    kind: string
    locks: Array<LaneLock>
  }> = []
  for (const row of waitingRows) {
    let entry = waiting.at(-1)
    if (entry?.id !== row.id) {
      entry = {
        admittedAt: Number(row.admitted_at),
        id: row.id,
        kind: row.kind,
        locks: [],
      }
      waiting.push(entry)
    }
    if (row.lock_key && row.mode) {
      entry.locks.push({ key: row.lock_key, mode: row.mode })
    }
  }
  const { granted } = selectGrants(held, waiting, {
    locksOf: (entry) => entry.locks,
  })
  if (granted.length === 0) return []
  const ids = granted.map((entry) => entry.id)
  const placeholders = ids.map(() => "?").join(", ")
  yield* transaction.execute(
    // A quick operation stays its admitting Hearth's, which runs it; the
    // granting Hearth drives a durable one's workflow.
    `UPDATE ${operationTable}
        SET state = 'granted', granted_at = ?, updated_at = ?,
            driver = IF(durable = 1, ?, driver)
      WHERE id IN (${placeholders})`,
    [now, now, hearthDriverId, ...ids]
  )
  yield* transaction.execute(
    `UPDATE ${lockTable} SET held = 1 WHERE operation_id IN (${placeholders})`,
    ids
  )
  for (const entry of granted) {
    yield* Metric.update(
      Metric.withAttributes(waitDuration, { "operation.kind": entry.kind }),
      (now - entry.admittedAt) / 1000
    )
  }
  return ids
})
