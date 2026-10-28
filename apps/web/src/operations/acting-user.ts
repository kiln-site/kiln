import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

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
 * The person an operation acts for, as their account is now, from what was
 * kept when they started it: one that's been removed, disabled, or
 * unverified since stops it.
 */
export const currentActingUser = Effect.fnUntraced(function* (
  saved: AuthenticatedUser
) {
  if (saved.isDevelopmentBypass) return saved
  const database = yield* Database
  const rows = yield* database.queryRows<ActorRow>(
    "operations.actingUser",
    `SELECT role, status, statusExpiresAt, emailVerifiedAt,
            manuallyVerifiedAt, legacyVerificationRecordedAt
       FROM ${databaseTable("user")} WHERE id = ? LIMIT 1`,
    [saved.id]
  )
  const current = rows[0]
  if (!current) {
    return yield* Effect.fail(
      new Error("The account that started this is gone")
    )
  }
  const actor: AuthenticatedUser = {
    ...saved,
    ...accountPolicyFromRow(current),
    role:
      current.role === "admin" || current.role === "relay_creator"
        ? current.role
        : "user",
  }
  if (!isAccountEnabled(actor) || !isAccountVerified(actor)) {
    return yield* Effect.fail(
      new Error("The account that started this can no longer act")
    )
  }
  return actor
})
