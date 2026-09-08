import { createHash, randomBytes, randomUUID } from "node:crypto"

import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import {
  isAccountEnabled,
  isAccountVerified,
  type AccountPolicy,
} from "@/lib/account-policy"
import { auth } from "@/lib/auth"
import { accountReturnPath } from "@/lib/account-return-path"
import { advanceSubjectAcrossEnabledRelaysEffect } from "@/lib/authorization-revision"
import { databaseTable } from "@/lib/database-config"
import { parseDisplayName } from "@/lib/display-name"
import { emailDeliveryConfig, kilnPublicUrl } from "@/lib/environment"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

interface ClaimUser extends RowDataPacket {
  id: string
  email: string
}
interface ClaimRow extends RowDataPacket {
  id: string
  user_id: string
  proof_method: "email" | "manual"
  created_by: string | null
  created_at: Date
  expires_at: Date
  consumed_at: Date | null
}
const CLAIM_LIFETIME_MS = 30 * 60 * 1000

export async function issueManualAccountClaim(input: {
  userId: string
  actorId: string
  developmentBypass?: boolean
}) {
  const result = await issueClaim({ ...input, method: "manual" })
  if (!result) throw new Error("This user already has sign-in credentials")
  return {
    token: result.token,
    claimUrl: result.claimUrl,
    expiresAt: result.expiresAt,
  }
}

export async function accountNeedsClaim(email: string): Promise<boolean> {
  return runAppEffect(
    "account.claim.check",
    Effect.gen(function* () {
      const database = yield* Database
      const rows = yield* database.queryRows<RowDataPacket>(
        "account.claim.check",
        `SELECT u.id FROM ${databaseTable("user")} u WHERE u.email = ?
       AND NOT EXISTS(SELECT 1 FROM ${databaseTable("account")} a WHERE a.userId = u.id)
       AND NOT EXISTS(SELECT 1 FROM ${databaseTable("passkey")} p WHERE p.userId = u.id) LIMIT 1`,
        [email]
      )
      return rows.length > 0
    })
  )
}

export async function requestEmailAccountClaim(
  email: string,
  returnPath?: string
): Promise<void> {
  const delivery = emailDeliveryConfig()
  if (!delivery) return
  const result = await issueClaim({ email, method: "email", actorId: null })
  if (!result) return
  const claimUrl = new URL(result.claimUrl)
  claimUrl.searchParams.set("redirect", accountReturnPath(returnPath))
  const resend = new Resend(delivery.apiKey)
  const response = await resend.emails.send(
    {
      from: delivery.from,
      to: [result.email],
      subject: "Claim your Kiln account",
      text: `Use this link to verify your email and set up your Kiln account. It expires in 30 minutes.\n\n${claimUrl.toString()}\n\nIf you did not request this, you can ignore this email.`,
    },
    { idempotencyKey: `account-claim/${result.id}` }
  )
  if (response.error)
    console.error("Could not send account claim email", response.error.message)
}

async function issueClaim(input: {
  actorId: string | null
  method: "email" | "manual"
  userId?: string
  email?: string
  developmentBypass?: boolean
}) {
  const token = randomBytes(32).toString("hex")
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + CLAIM_LIFETIME_MS)
  const subject = await runAppEffect(
    "account.claim.issue",
    Effect.gen(function* () {
      const database = yield* Database
      return yield* database.transaction("account.claim.issue", (transaction) =>
        Effect.gen(function* () {
          if (input.method === "manual") {
            const admins = yield* transaction.queryRows<
              RowDataPacket & AccountPolicy & { id: string }
            >(
              `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
            )
            if (
              !input.developmentBypass &&
              !admins.some(
                (admin) =>
                  admin.id === input.actorId &&
                  isAccountEnabled(admin) &&
                  isAccountVerified(admin)
              )
            ) {
              return yield* Effect.fail(
                new Error("Platform administrator required")
              )
            }
          }
          const users = yield* transaction.queryRows<ClaimUser>(
            `SELECT id, email FROM ${databaseTable("user")} WHERE ${input.userId ? "id" : "email"} = ? FOR UPDATE`,
            [input.userId ?? input.email ?? ""]
          )
          const user = users[0]
          if (!user) return null
          if (yield* hasCredentials(transaction, user.id)) return null
          const existing = yield* transaction.queryRows<ClaimRow>(
            `SELECT * FROM ${databaseTable("account_claim")} WHERE user_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [user.id]
          )
          if (
            input.method === "email" &&
            existing[0] &&
            (existing[0].created_at.getTime() > Date.now() - 60_000 ||
              (existing[0].proof_method === "manual" &&
                !existing[0].consumed_at &&
                existing[0].expires_at.getTime() > Date.now()))
          )
            return null
          // Never expose an earlier token again. Reissue invalidates all previous
          // attempts without removing their audit records.
          yield* transaction.execute(
            `UPDATE ${databaseTable("account_claim")} SET consumed_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND consumed_at IS NULL`,
            [user.id]
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("account_claim")} (id, user_id, token_hash, proof_method, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              id,
              user.id,
              tokenHash(token),
              input.method,
              input.actorId,
              expiresAt,
            ]
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'account.claim.issued', ?)`,
            [
              user.id,
              JSON.stringify({
                actorId: input.actorId,
                claimId: id,
                method: input.method,
              }),
            ]
          )
          return user
        })
      )
    })
  )
  if (!subject) return null
  const url = new URL("/claim", kilnPublicUrl())
  url.searchParams.set("token", token)
  return {
    id,
    token,
    email: subject.email,
    claimUrl: url.toString(),
    expiresAt: expiresAt.toISOString(),
  }
}

export async function redeemAccountClaim(input: {
  token: string
  password: string
  displayName: string
}) {
  const name = parseDisplayName(input.displayName)
  if (input.password.length < 12 || input.password.length > 128)
    throw new Error("Password must contain 12–128 characters")
  // Reject unknown/expired challenges before expensive password hashing.
  // The random 256-bit token is the authentication proof; the transaction
  // rechecks it under lock so this preflight cannot authorize a stale claim.
  await runAppEffect(
    "account.claim.preflight",
    Effect.gen(function* () {
      const database = yield* Database
      const rows = yield* database.queryRows<ClaimRow>(
        "account.claim.preflight",
        `SELECT id FROM ${databaseTable("account_claim")} WHERE token_hash = ?
        AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3) LIMIT 1`,
        [tokenHash(input.token)]
      )
      if (!rows[0])
        return yield* Effect.fail(
          new Error("This account claim is invalid or expired")
        )
    })
  )
  // Hash before opening the transaction; hold locks only for the atomic claim.
  const [context, { wakeAuthorizationDelivery }] = await Promise.all([
    auth.$context,
    import("@/lib/authorization-delivery"),
  ])
  const password = await context.password.hash(input.password)
  const result = await runAppEffect(
    "account.claim.redeem",
    Effect.gen(function* () {
      const database = yield* Database
      return yield* database.transaction(
        "account.claim.redeem",
        (transaction) =>
          Effect.gen(function* () {
            const attempts = yield* transaction.queryRows<ClaimRow>(
              `SELECT * FROM ${databaseTable("account_claim")} WHERE token_hash = ?`,
              [tokenHash(input.token)]
            )
            const candidate = attempts[0]
            if (!candidate)
              return yield* Effect.fail(
                new Error("This account claim is invalid or expired")
              )
            const users = yield* transaction.queryRows<ClaimUser>(
              `SELECT id, email FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
              [candidate.user_id]
            )
            const claims = yield* transaction.queryRows<ClaimRow>(
              `SELECT * FROM ${databaseTable("account_claim")} WHERE id = ? FOR UPDATE`,
              [candidate.id]
            )
            const claim = claims[0]
            const user = users[0]
            if (
              !user ||
              !claim ||
              claim.consumed_at ||
              claim.expires_at.getTime() <= Date.now() ||
              (yield* hasCredentials(transaction, user.id))
            ) {
              return yield* Effect.fail(
                new Error("This account claim is invalid or expired")
              )
            }
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("account")} (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
              [randomUUID(), user.id, user.id, password]
            )
            yield* transaction.execute(
              claim.proof_method === "email"
                ? `UPDATE ${databaseTable("user")} SET name = ?, emailVerified = TRUE, emailVerifiedAt = CURRENT_TIMESTAMP(3), updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`
                : `UPDATE ${databaseTable("user")} SET name = ?, manuallyVerifiedAt = CURRENT_TIMESTAMP(3), manuallyVerifiedBy = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
              claim.proof_method === "email"
                ? [name, user.id]
                : [name, claim.created_by, user.id]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("account_claim")} SET consumed_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND consumed_at IS NULL`,
              [user.id]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'account.claim.redeemed', ?)`,
              [
                user.id,
                JSON.stringify({
                  actorId: user.id,
                  issuerId: claim.created_by,
                  claimId: claim.id,
                  method: claim.proof_method,
                }),
              ]
            )
            const revision = yield* advanceSubjectAcrossEnabledRelaysEffect(
              transaction,
              user.id,
              [{ kind: "subject_relay" }]
            )
            return { ...revision, userId: user.id, email: user.email }
          })
      )
    })
  )
  for (const relayId of result.relayIds) wakeAuthorizationDelivery(relayId)
  publishRealtimeChange({
    type: "access.changed",
    reauthenticate: true,
    userIds: [result.userId],
  })
  return { email: result.email }
}

function hasCredentials(transaction: DatabaseTransaction, userId: string) {
  return transaction
    .queryRows<RowDataPacket>(
      `SELECT id FROM ${databaseTable("account")} WHERE userId = ?
       UNION ALL SELECT id FROM ${databaseTable("passkey")} WHERE userId = ? LIMIT 1`,
      [userId, userId]
    )
    .pipe(Effect.map((rows) => rows.length > 0))
}
function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}
