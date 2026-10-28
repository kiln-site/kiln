import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import {
  accountPolicyFromRow,
  isAccountEnabled,
  isAccountVerified,
} from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"

interface ActorRow extends RowDataPacket {
  emailVerifiedAt: Date | null
  legacyVerificationRecordedAt: Date | null
  manuallyVerifiedAt: Date | null
  role: string | null
  status: string | null
  statusExpiresAt: Date | null
}

/**
 * The person a long operation acts for, as their account is now: the one
 * saved when they asked, with their role and standing read again. One that's
 * been disabled or deleted since can no longer act, and fails here.
 */
export const currentActingUser = Effect.fnUntraced(function* (
  userId: string,
  saved: unknown
) {
  const actor = (
    typeof saved === "string" ? JSON.parse(saved) : saved
  ) as AuthenticatedUser
  if (actor.isDevelopmentBypass) return actor
  const database = yield* Database
  const rows = yield* database.queryRows<ActorRow>(
    "operations.actingUser",
    `SELECT role, status, statusExpiresAt, emailVerifiedAt,
            manuallyVerifiedAt, legacyVerificationRecordedAt
       FROM ${databaseTable("user")} WHERE id = ? LIMIT 1`,
    [userId]
  )
  const current = rows[0]
  if (!current) {
    return yield* Effect.fail(
      new Error("The account that started this is gone")
    )
  }
  const user: AuthenticatedUser = {
    ...actor,
    ...accountPolicyFromRow(current),
    id: userId,
    role:
      current.role === "admin" || current.role === "relay_creator"
        ? current.role
        : "user",
  }
  if (!isAccountEnabled(user) || !isAccountVerified(user)) {
    return yield* Effect.fail(
      new Error("The account that started this can no longer act")
    )
  }
  return user
})
