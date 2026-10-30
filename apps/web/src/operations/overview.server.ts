import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

import { hearthLanes, laneOccupants, type Initiator } from "./lanes"
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

/** An operation in the lanes now, running or waiting its turn. */
export interface LaneView {
  readonly actor: { readonly id: string; readonly name: string } | null
  readonly admittedAt: number
  readonly doing: string
  readonly durable: boolean
  readonly id: string
  readonly initiator: Initiator
  readonly locks: ReadonlyArray<{ readonly key: string; readonly mode: string }>
  readonly name: string
  readonly startedAt: number | null
  /** What a waiting one waits for: each holder or one ahead, by key. */
  readonly waitingOn: ReadonlyArray<{
    readonly holds: boolean
    readonly key: string
    readonly name: string
  }>
}

export interface OperationsOverview {
  /** What's in the lanes now, in the order it arrived. */
  readonly lanes: ReadonlyArray<LaneView>
  /** Durable operations running now, oldest first. */
  readonly running: ReadonlyArray<OperationView>
  /** The latest durable operations to end, newest first. */
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

/**
 * What's in Hearth's lanes now, live, and its durable operations running
 * and ended last.
 */
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
    const lanes = hearthLanes.describe()
    const occupants = [...lanes.active, ...lanes.waiting].flatMap((entry) => {
      const occupant = laneOccupants.get(entry.label)
      return occupant ? [{ entry, occupant }] : []
    })
    const actorIds = [
      ...new Set([
        ...[...running, ...recent].flatMap((row) =>
          row.actor_id ? [row.actor_id] : []
        ),
        ...occupants.flatMap(({ occupant }) =>
          occupant.actorId ? [occupant.actorId] : []
        ),
      ]),
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
    const actorOf = (id: string | null) =>
      id ? { id, name: names.get(id) ?? "Someone" } : null
    return {
      lanes: occupants
        .map(({ entry, occupant }) => ({
          actor: actorOf(occupant.actorId),
          admittedAt: occupant.admittedAt,
          doing: occupant.doing,
          durable: occupant.durable,
          id: occupant.id,
          initiator: occupant.initiator,
          locks: entry.locks ?? [],
          name: occupant.name,
          startedAt: occupant.startedAt,
          waitingOn:
            "waitingOn" in entry
              ? entry.waitingOn.map((reason) => ({
                  holds: reason.holds,
                  key: reason.key,
                  name: laneOccupants.get(reason.id)?.name ?? reason.id,
                }))
              : [],
        }))
        .sort((left, right) => left.admittedAt - right.admittedAt),
      recent: recent.map(view),
      running: running.map(view),
    } satisfies OperationsOverview
  }
)
