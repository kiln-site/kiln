import {
  explainWait,
  type LaneLock,
  type LaneMode,
} from "@workspace/operations"
import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

import type { OperationProgress, OperationState } from "./lanes"

const operationTable = databaseTable("operation")
const lockTable = databaseTable("operation_lock")
const userTable = databaseTable("user")

// The operator view lists at most this many of what's in the lanes, and of
// what ended last.
const ACTIVE_LIMIT = 200
const RECENT_LIMIT = 50

export interface OperationLockView {
  readonly held: boolean
  readonly key: string
  readonly mode: LaneMode
}

/** What a waiting operation waits on: one ahead of it, on one key. */
export interface OperationWaitView {
  readonly holds: boolean
  readonly key: string
  readonly kind: string
  readonly operationId: string
}

export interface OperationView {
  readonly actor: { readonly id: string; readonly name: string } | null
  readonly admittedAt: number
  readonly durable: boolean
  readonly error: string | null
  readonly finishedAt: number | null
  readonly grantedAt: number | null
  readonly id: string
  readonly kind: string
  readonly locks: ReadonlyArray<OperationLockView>
  readonly progress: OperationProgress | null
  readonly startedAt: number | null
  readonly state: OperationState
  readonly waitingOn: ReadonlyArray<OperationWaitView>
}

export interface OperationsOverview {
  /** Waiting, granted, and running, in the order they arrived. */
  readonly active: ReadonlyArray<OperationView>
  /** The latest to end, newest first. */
  readonly recent: ReadonlyArray<OperationView>
}

type OperationRow = RowDataPacket & {
  actor_id: string | null
  admitted_at: number
  durable: number
  error: string | null
  finished_at: number | null
  granted_at: number | null
  id: string
  kind: string
  progress: OperationProgress | string | null
  started_at: number | null
  state: OperationState
}

const columns = `id, kind, durable, state, actor_id, error, progress,
  admitted_at, granted_at, started_at, finished_at`

/** What Hearth's lanes hold now, and what ended last. */
export const loadOperationsOverview = Effect.fn("Operations.overview")(
  function* () {
    const database = yield* Database
    const active = yield* database.queryRows<OperationRow>(
      "operations.overview",
      `SELECT ${columns} FROM ${operationTable}
        WHERE state IN ('waiting', 'granted', 'running')
        ORDER BY sequence
        LIMIT ${ACTIVE_LIMIT}`
    )
    const recent = yield* database.queryRows<OperationRow>(
      "operations.overview",
      `SELECT ${columns} FROM ${operationTable}
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT ${RECENT_LIMIT}`
    )
    const lockRows =
      active.length === 0
        ? []
        : yield* database.queryRows<
            RowDataPacket & {
              held: number
              lock_key: string
              mode: LaneMode
              operation_id: string
            }
          >(
            "operations.overview",
            `SELECT operation_id, lock_key, mode, held FROM ${lockTable}
              WHERE operation_id IN (${placeholders(active)})`,
            active.map((row) => row.id)
          )
    const actorIds = [
      ...new Set(
        [...active, ...recent].flatMap((row) =>
          row.actor_id ? [row.actor_id] : []
        )
      ),
    ]
    const actorRows =
      actorIds.length === 0
        ? []
        : yield* database.queryRows<
            RowDataPacket & { id: string; name: string }
          >(
            "operations.overview",
            `SELECT id, name FROM ${userTable}
              WHERE id IN (${placeholders(actorIds)})`,
            actorIds
          )

    const names = new Map(actorRows.map((row) => [row.id, row.name]))
    const locks = new Map<string, Array<OperationLockView>>()
    for (const row of lockRows) {
      const list = locks.get(row.operation_id) ?? []
      list.push({ held: Boolean(row.held), key: row.lock_key, mode: row.mode })
      locks.set(row.operation_id, list)
    }
    const kinds = new Map(active.map((row) => [row.id, row.kind]))
    const lanesOf = (id: string, held: boolean): Array<LaneLock> =>
      (locks.get(id) ?? [])
        .filter((lock) => lock.held === held)
        .map(({ key, mode }) => ({ key, mode }))
    // What holds a lock, and what waits ahead in line, by arrival order.
    const holders = active
      .filter((row) => row.state !== "waiting")
      .map((row) => ({ id: row.id, locks: lanesOf(row.id, true) }))
    const ahead: Array<{ id: string; locks: Array<LaneLock> }> = []

    const view = (
      row: OperationRow,
      waitingOn: ReadonlyArray<OperationWaitView>
    ): OperationView => ({
      actor: row.actor_id
        ? { id: row.actor_id, name: names.get(row.actor_id) ?? "Someone" }
        : null,
      admittedAt: Number(row.admitted_at),
      durable: Boolean(row.durable),
      error: row.error,
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      grantedAt: row.granted_at === null ? null : Number(row.granted_at),
      id: row.id,
      kind: row.kind,
      locks: locks.get(row.id) ?? [],
      progress:
        typeof row.progress === "string"
          ? (JSON.parse(row.progress) as OperationProgress)
          : row.progress,
      startedAt: row.started_at === null ? null : Number(row.started_at),
      state: row.state,
      waitingOn,
    })

    return {
      active: active.map((row) => {
        if (row.state !== "waiting") return view(row, [])
        const wants = lanesOf(row.id, false)
        const reasons = explainWait(wants, holders, ahead).map((reason) => ({
          holds: reason.holds,
          key: reason.key,
          kind: kinds.get(reason.id) ?? "",
          operationId: reason.id,
        }))
        ahead.push({ id: row.id, locks: wants })
        return view(row, reasons)
      }),
      recent: recent.map((row) => view(row, [])),
    } satisfies OperationsOverview
  }
)

const placeholders = (values: ReadonlyArray<unknown>) =>
  values.map(() => "?").join(", ")
