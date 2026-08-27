import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

interface AccountSessionRow extends RowDataPacket {
  created_at: Date
  expires_at: Date
  id: string
  ip_address: string | null
  user_agent: string | null
  user_id: string
}

interface ActiveSessionRow extends RowDataPacket {
  id: string
}

export interface AccountSessionSummary {
  createdAt: string
  expiresAt: string
  id: string
  ipAddress: string | null
  userAgent: string | null
}

export const listAccountSessionsEffect = Effect.fn("auth.sessions.list")(
  function* (userId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<AccountSessionRow>(
      "auth.sessions.list",
      `SELECT id,
              userId AS user_id,
              createdAt AS created_at,
              expiresAt AS expires_at,
              ipAddress AS ip_address,
              userAgent AS user_agent
         FROM ${databaseTable("session")}
        WHERE userId = ?
          AND expiresAt > CURRENT_TIMESTAMP(3)
        ORDER BY createdAt DESC`,
      [userId]
    )

    const sessions: Array<AccountSessionSummary> = []
    for (const row of rows) {
      if (row.user_id !== userId) continue
      sessions.push({
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        id: row.id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
      })
    }
    return sessions
  }
)

export const revokeAccountSessionEffect = Effect.fn("auth.sessions.revoke")(
  function* (userId: string, sessionId: string) {
    const database = yield* Database
    yield* database.execute(
      "auth.sessions.revoke",
      `DELETE FROM ${databaseTable("session")}
        WHERE id = ?
          AND userId = ?`,
      [sessionId, userId]
    )
  }
)

export const accountSessionActiveEffect = Effect.fn(
  "auth.sessions.realtimeValidate"
)(function* (userId: string, sessionId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<ActiveSessionRow>(
    "auth.sessions.realtimeValidate",
    `SELECT id
       FROM ${databaseTable("session")}
      WHERE id = ?
        AND userId = ?
        AND expiresAt > CURRENT_TIMESTAMP(3)
      LIMIT 1`,
    [sessionId, userId]
  )
  return rows[0]?.id === sessionId
})
