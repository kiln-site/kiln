import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface SystemUpdateOperationRecord {
  component: "hearth" | "relay"
  deadlineAt: number
  operationId: string
  relayId: string
}

interface SystemUpdateOperationRow extends RowDataPacket {
  component: SystemUpdateOperationRecord["component"]
  deadline_at: number | string
  operation_id: string
  relay_id: string
}

export const listSystemUpdateOperationsEffect = Effect.fn(
  "systemUpdateOperations.list"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<SystemUpdateOperationRow>(
    "systemUpdateOperations.list",
    `SELECT operation_id, relay_id, component, deadline_at
       FROM ${databaseTable("system_update_operation")}`
  )
  return rows.map((row): SystemUpdateOperationRecord => ({
    component: row.component,
    deadlineAt: Number(row.deadline_at),
    operationId: row.operation_id,
    relayId: row.relay_id,
  }))
})

export const recordSystemUpdateOperationEffect = Effect.fn(
  "systemUpdateOperations.record"
)(function* (operation: SystemUpdateOperationRecord) {
  const database = yield* Database
  yield* database.execute(
    "systemUpdateOperations.record",
    `INSERT INTO ${databaseTable("system_update_operation")}
       (operation_id, relay_id, component, deadline_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE operation_id = operation_id`,
    [
      operation.operationId,
      operation.relayId,
      operation.component,
      operation.deadlineAt,
    ]
  )
})

export const forgetSystemUpdateOperationEffect = Effect.fn(
  "systemUpdateOperations.forget"
)(function* (operationId: string) {
  const database = yield* Database
  yield* database.execute(
    "systemUpdateOperations.forget",
    `DELETE FROM ${databaseTable("system_update_operation")}
      WHERE operation_id = ?`,
    [operationId]
  )
})
