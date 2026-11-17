import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Predicate } from "effect"

import { Database } from "@/effect/database"
import {
  AuthenticationError,
  TwoFactorAttemptsError,
  TwoFactorRequiredError,
} from "@/effect/errors"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"

// Wrong codes an account may enter in this long, across every check that
// asks for a fresh one, before none is checked until the oldest falls out.
// Kept in the audit log, as wrong passwords are (`auth-password.ts`), so
// every Hearth process counts the same ones. Signing in counts its own.
const FAILED_ATTEMPTS = 5
const FAILED_ATTEMPTS_WINDOW_MS = 15 * 60_000

const codeDidNotMatch = () =>
  AuthenticationError.make({ message: "That code didn't match. Try again." })

/**
 * Asks a signed-in person for a fresh second factor before something only
 * they should see: a code from their authenticator app, or one of their
 * backup codes, which it uses up. Better Auth checks it against the
 * account's own two-factor record, through the session `headers` carry,
 * which must be `user`'s. Accounts without two-factor authentication are
 * refused; nothing stands in for it.
 */
export const requireTwoFactorCodeEffect = Effect.fn("auth.twoFactor.confirm")(
  function* (user: AuthenticatedUser, code: string | null, headers: Headers) {
    if (!user.twoFactorEnabled || user.isDevelopmentBypass) {
      return yield* TwoFactorRequiredError.make({
        message:
          "Turn on two-factor authentication in your account settings first.",
      })
    }
    const entered = (code ?? "").replace(/\s/gu, "")
    if (!entered) {
      return yield* AuthenticationError.make({
        message:
          "Enter the code from your authenticator app, or a backup code.",
      })
    }

    // An attempt is reserved before its code is checked, holding the
    // account's row so reservations are counted one at a time, as with
    // passwords: however many arrive at once, no more than the limit are
    // ever checked.
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const attempt = yield* database.transaction(
      "auth.twoFactorAttempt",
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
                AND event IN ('account.two-factor.failed',
                              'account.two-factor.checking')
                AND created_at >= ?`,
            [user.id, now - FAILED_ATTEMPTS_WINDOW_MS]
          )
          if (Number(recent?.total ?? 0) >= FAILED_ATTEMPTS) {
            return yield* TwoFactorAttemptsError.make({
              message: "Too many wrong codes. Wait 15 minutes, then try again.",
            })
          }
          const reserved = yield* transaction.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, created_at)
             VALUES (?, 'account.two-factor.checking', ?)`,
            [user.id, now]
          )
          return reserved.insertId
        })
    )

    const matches = yield* Effect.tryPromise({
      try: async () => {
        const { auth } = await import("@/lib/auth")
        // Six digits are an authenticator code; anything else, a backup
        // code (`xxxxx-xxxxx`). With a session, Better Auth verifies for
        // its user and signs no one in; a backup code is used up.
        if (/^\d{6}$/u.test(entered)) {
          await auth.api.verifyTOTP({ body: { code: entered }, headers })
        } else {
          await auth.api.verifyBackupCode({
            body: { code: entered, disableSession: true },
            headers,
          })
        }
        return true
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        rejectedCode(cause)
          ? Effect.succeed(false)
          : Effect.fail(
              AuthenticationError.make({
                message: "The code could not be verified.",
                cause,
              })
            )
      )
    )
    // A right code frees its attempt; a wrong one keeps it, as a failure.
    // One whose check never finished keeps counting as checking.
    if (matches) {
      yield* database.execute(
        "auth.twoFactorAttempt.passed",
        `DELETE FROM ${databaseTable("auth_audit")} WHERE id = ?`,
        [attempt]
      )
      return
    }
    yield* database.execute(
      "auth.twoFactorAttempt.failed",
      `UPDATE ${databaseTable("auth_audit")}
          SET event = 'account.two-factor.failed'
        WHERE id = ?`,
      [attempt]
    )
    return yield* codeDidNotMatch()
  }
)

// Better Auth answers a wrong code, TOTP or backup, with 401.
function rejectedCode(cause: unknown): boolean {
  return (
    Predicate.hasProperty(cause, "status") && cause.status === "UNAUTHORIZED"
  )
}
