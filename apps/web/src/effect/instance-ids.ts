import { newInstanceId, type InstanceIdKind } from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2"

import { databaseTable } from "@/lib/database-config"

import { Database } from "./database"
import { runAppEffect } from "./runtime"

/**
 * Hearth's instance directory reserves every instance ID, for good: a
 * deleted instance's ID is never handed out again, so nothing that still
 * names it can come to mean another instance.
 *
 * A reservation made for a request (`requestKey`, such as a create's
 * idempotency key) returns the same ID however often that request is
 * retried. A random ID that's already taken is replaced by another.
 */
export const reserveInstanceIdEffect = Effect.fn("instanceIds.reserve")(
  function* (kind: InstanceIdKind, requestKey: string | null = null) {
    const database = yield* Database
    if (requestKey !== null) {
      const existing = yield* reservedFor(requestKey)
      if (existing) return existing
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = newInstanceId()
      const result = yield* database.execute(
        "instanceIds.reserve",
        `INSERT IGNORE INTO ${databaseTable("instance_id")}
           (id, kind, request_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [id, kind, requestKey, Date.now()]
      )
      if (result.affectedRows === 1) return id
      // Another reservation for this request may have won the race.
      if (requestKey !== null) {
        const existing = yield* reservedFor(requestKey)
        if (existing) return existing
      }
    }
    return yield* Effect.die(
      new Error("Couldn't reserve an unused instance ID")
    )
  }
)

/**
 * Reserves an ID something else chose, such as the one a Relay generated
 * for itself or for a game server it created. Fails if another instance
 * already holds it.
 */
export const claimInstanceIdEffect = Effect.fn("instanceIds.claim")(function* (
  kind: InstanceIdKind,
  id: string
) {
  const database = yield* Database
  yield* database.execute(
    "instanceIds.claim",
    `INSERT IGNORE INTO ${databaseTable("instance_id")}
       (id, kind, request_key, created_at)
     VALUES (?, ?, NULL, ?)`,
    [id, kind, Date.now()]
  )
  const rows = yield* database.queryRows<RowDataPacket & { kind: string }>(
    "instanceIds.claim.read",
    `SELECT kind FROM ${databaseTable("instance_id")} WHERE id = ?`,
    [id]
  )
  if (rows[0]?.kind !== kind) {
    return yield* Effect.fail(
      new InstanceIdTakenError(
        `Instance ID ${id} already belongs to another instance`
      )
    )
  }
  return id
})

export class InstanceIdTakenError extends Error {
  readonly _tag = "InstanceIdTakenError"
}

const reservedFor = Effect.fn("instanceIds.reservedFor")(function* (
  requestKey: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
    "instanceIds.reservedFor",
    `SELECT id FROM ${databaseTable("instance_id")} WHERE request_key = ?`,
    [requestKey]
  )
  return rows[0]?.id ?? null
})

export function reserveInstanceId(
  kind: InstanceIdKind,
  requestKey: string | null = null
): Promise<string> {
  return runAppEffect(
    "instanceIds.reserve",
    reserveInstanceIdEffect(kind, requestKey)
  )
}
