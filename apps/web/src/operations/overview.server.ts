import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

import type { OperationState } from "./records"

const operationTable = databaseTable("operation")
const userTable = databaseTable("user")

// The operator view lists at most this many of what runs, and of what ended
// last.
const RUNNING_LIMIT = 200
const RECENT_LIMIT = 50

export interface OperationView {
  readonly actor: { readonly id: string; readonly name: string } | null
  readonly createdAt: number
  readonly error: string | null
  readonly finishedAt: number | null
  readonly id: string
  readonly kind: string
  readonly state: OperationState
}

export interface OperationsOverview {
  /** What runs now, oldest first. */
  readonly running: ReadonlyArray<OperationView>
  /** The latest to end, newest first. */
  readonly recent: ReadonlyArray<OperationView>
}

type OperationRow = RowDataPacket & {
  actor_id: string | null
  created_at: number
  error: string | null
  finished_at: number | null
  id: string
  kind: string
  state: OperationState
}

const columns = "id, kind, state, actor_id, error, created_at, finished_at"

/** Hearth's durable operations running now, and what ended last. */
export const loadOperationsOverview = Effect.fn("Operations.overview")(
  function* () {
    const database = yield* Database
    const running = yield* database.queryRows<OperationRow>(
      "operations.overview",
      `SELECT ${columns} FROM ${operationTable}
        WHERE state = 'running'
        ORDER BY created_at
        LIMIT ${RUNNING_LIMIT}`
    )
    const recent = yield* database.queryRows<OperationRow>(
      "operations.overview",
      `SELECT ${columns} FROM ${operationTable}
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT ${RECENT_LIMIT}`
    )
    const actorIds = [
      ...new Set(
        [...running, ...recent].flatMap((row) =>
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
              WHERE id IN (${actorIds.map(() => "?").join(", ")})`,
            actorIds
          )
    const names = new Map(actorRows.map((row) => [row.id, row.name]))
    const view = (row: OperationRow): OperationView => ({
      actor: row.actor_id
        ? { id: row.actor_id, name: names.get(row.actor_id) ?? "Someone" }
        : null,
      createdAt: Number(row.created_at),
      error: row.error,
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      id: row.id,
      kind: row.kind,
      state: row.state,
    })
    return {
      recent: recent.map(view),
      running: running.map(view),
    } satisfies OperationsOverview
  }
)
