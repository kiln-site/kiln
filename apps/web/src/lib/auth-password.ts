import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { AuthenticationError } from "@/effect/errors"
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
    if (!hash) return yield* passwordDidNotMatch()

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
    if (!matches) return yield* passwordDidNotMatch()
  }
)
