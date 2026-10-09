import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface SystemUpdateRecord {
  component: "hearth" | "relay"
  deadlineAt: number
  id: string
  // Null until the Relay returns the operation it started.
  operationId: string | null
  relayId: string
}

interface SystemUpdateRow extends RowDataPacket {
  component: SystemUpdateRecord["component"]
  deadline_at: number | string
  id: string
  operation_id: string | null
  relay_id: string
}

export const listSystemUpdatesEffect = Effect.fn("systemUpdates.list")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<SystemUpdateRow>(
      "systemUpdates.list",
      `SELECT id, relay_id, component, operation_id, deadline_at
         FROM ${databaseTable("system_update_operation")}`
    )
    return rows.map((row): SystemUpdateRecord => ({
      component: row.component,
      deadlineAt: Number(row.deadline_at),
      id: row.id,
      operationId: row.operation_id,
      relayId: row.relay_id,
    }))
  }
)

export const recordSystemUpdatesEffect = Effect.fn("systemUpdates.record")(
  function* (updates: ReadonlyArray<SystemUpdateRecord>) {
    const database = yield* Database
    for (const update of updates) {
      yield* database.execute(
        "systemUpdates.record",
        `INSERT INTO ${databaseTable("system_update_operation")}
           (id, relay_id, component, operation_id, deadline_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          update.id,
          update.relayId,
          update.component,
          update.operationId,
          update.deadlineAt,
        ]
      )
    }
  }
)

export const attachSystemUpdateOperationEffect = Effect.fn(
  "systemUpdates.attachOperation"
)(function* (id: string, operationId: string) {
  const database = yield* Database
  yield* database.execute(
    "systemUpdates.attachOperation",
    `UPDATE ${databaseTable("system_update_operation")}
        SET operation_id = ?
      WHERE id = ?`,
    [operationId, id]
  )
})

export const forgetSystemUpdateEffect = Effect.fn("systemUpdates.forget")(
  function* (id: string) {
    const database = yield* Database
    yield* database.execute(
      "systemUpdates.forget",
      `DELETE FROM ${databaseTable("system_update_operation")} WHERE id = ?`,
      [id]
    )
  }
)
