import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { AuthenticationError, PasswordAttemptsError } from "@/effect/errors"
import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { isDevelopmentBypassIdentity } from "@/lib/development-bypass"
import { developmentBypassEnabled } from "@/lib/environment"

interface CredentialAccountRow extends RowDataPacket {
  password: string | null
}

interface AccountPasswordIdentity {
  id: string
  isDevelopmentBypass: boolean
}

// Wrong passwords an account may enter in this long, across every check
// that asks for one (deletions in the browser and the CLI, host restarts),
// before none is checked until the oldest falls out. Kept in the audit log,
// so every Hearth process counts the same ones.
const FAILED_ATTEMPTS = 5
const FAILED_ATTEMPTS_WINDOW_MS = 15 * 60_000

const passwordDidNotMatch = () =>
  AuthenticationError.make({
    message: "The account password did not match.",
  })

export async function requireAccountPassword(
  user: AccountPasswordIdentity,
  password: string
): Promise<void> {
  return runAppEffect(
    "auth.password.confirm",
    requireAccountPasswordEffect(user, password)
  )
}

export const requireAccountPasswordEffect = Effect.fn("auth.password.confirm")(
  function* (user: AccountPasswordIdentity, password: string) {
    if (isDevelopmentBypassIdentity(user)) {
      if (developmentBypassEnabled() && password.length === 0) return
      return yield* passwordDidNotMatch()
    }

    const database = yield* Database
    const accounts = yield* database.queryRows<CredentialAccountRow>(
      "auth.passwordAccount",
      `SELECT password
      FROM ${databaseTable("account")}
      WHERE userId = ? AND providerId = 'credential'
      LIMIT 1`,
      [user.id]
    )
    const hash = accounts.at(0)?.password
    // Every way of joining Kiln sets a password; one set up some other way
    // gets one by the emailed reset, which adds it.
    if (!hash) {
      return yield* AuthenticationError.make({
        message:
          "Your account has no password yet. Sign out, choose “Forgot password?” on the sign-in page to set one by email, then try again.",
      })
    }

    // An attempt is reserved before its password is checked, holding the
    // account's row so reservations are counted one at a time: wrong
    // passwords and attempts still being checked both count, so however
    // many arrive at once, no more than the limit are ever checked. The
    // check itself runs after, without the lock.
    const now = yield* Clock.currentTimeMillis
    const attempt = yield* database.transaction(
      "auth.passwordAttempt",
      (transaction) =>
        Effect.gen(function* () {
          yield* transaction.queryRows(
            `SELECT id FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
            [user.id]
          )
          const [recent] = yield* transaction.queryRows<
            RowDataPacket & { total: number | string }
          >(
            `SELECT COUNT(*) AS total FROM ${databaseTable("auth_audit")}
              WHERE user_id = ?
                AND event IN ('account.password.failed',
                              'account.password.checking')
                AND created_at >= ?`,
            [user.id, now - FAILED_ATTEMPTS_WINDOW_MS]
          )
          if (Number(recent?.total ?? 0) >= FAILED_ATTEMPTS) {
            return yield* PasswordAttemptsError.make({
              message:
                "Too many wrong passwords. Wait 15 minutes, then try again.",
            })
          }
          const reserved = yield* transaction.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, created_at)
             VALUES (?, 'account.password.checking', ?)`,
            [user.id, now]
          )
          return reserved.insertId
        })
    )

    const matches = yield* Effect.tryPromise({
      try: async () => {
        const { auth } = await import("@/lib/auth")
        const context = await auth.$context
        return context.password.verify({ hash, password })
      },
      catch: (cause) =>
        AuthenticationError.make({
          message: "The account password could not be verified.",
          cause,
        }),
    })
    // A right password frees its attempt; a wrong one keeps it, as a
    // failure. One whose check never finished keeps counting as checking.
    if (matches) {
      yield* database.execute(
        "auth.passwordAttempt.passed",
        `DELETE FROM ${databaseTable("auth_audit")} WHERE id = ?`,
        [attempt]
      )
      return
    }
    yield* database.execute(
      "auth.passwordAttempt.failed",
      `UPDATE ${databaseTable("auth_audit")}
          SET event = 'account.password.failed'
        WHERE id = ?`,
      [attempt]
    )
    return yield* passwordDidNotMatch()
  }
)
