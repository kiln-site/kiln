import { createHash, randomBytes, randomUUID } from "node:crypto"

import { Clock, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { AccountClaimEmail } from "@/emails/account-claim-email"
import { kilnEmailAttachments } from "@/emails/kiln-email"
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
import type { InvitationReference } from "@/lib/invitation-auth"
import { invitationLinkPurpose } from "@/lib/invitation-link-key"
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
  created_at: number
  expires_at: number
  consumed_at: number | null
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

// The opaque claim token is the authority to preview this address. Previewing
// never consumes the challenge or establishes either kind of verification.
export async function previewAccountClaim(token: string) {
  if (!/^[a-f0-9]{64}$/u.test(token)) return null
  return runAppEffect(
    "account.claim.preview",
    Effect.gen(function* () {
      const database = yield* Database
      const rows = yield* database.queryRows<
        RowDataPacket & {
          email: string
          consumed_at: number | null
          expires_at: number
          hasCredential: number
        }
      >(
        "account.claim.preview",
        `SELECT u.email, c.consumed_at, c.expires_at,
          (EXISTS(SELECT 1 FROM ${databaseTable("account")} a WHERE a.userId = u.id)
          OR EXISTS(SELECT 1 FROM ${databaseTable("passkey")} p WHERE p.userId = u.id)) AS hasCredential
         FROM ${databaseTable("account_claim")} c
         JOIN ${databaseTable("user")} u ON u.id = c.user_id
         WHERE c.token_hash = ? LIMIT 1`,
        [tokenHash(token)]
      )
      const claim = rows[0]
      if (
        !claim ||
        claim.consumed_at ||
        claim.expires_at <= (yield* Clock.currentTimeMillis) ||
        claim.hasCredential
      )
        return null
      return { email: claim.email }
    })
  )
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
      subject: "Set up your Kiln account",
      react: AccountClaimEmail({
        claimUrl: claimUrl.toString(),
        email: result.email,
        hearthUrl: kilnPublicUrl().toString(),
      }),
      attachments: kilnEmailAttachments,
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
  const now = Date.now()
  const expiresAt = now + CLAIM_LIFETIME_MS
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
            (existing[0].created_at > now - 60_000 ||
              (existing[0].proof_method === "manual" &&
                !existing[0].consumed_at &&
                existing[0].expires_at > now))
          )
            return null
          // Never expose an earlier token again. Reissue invalidates all previous
          // attempts without removing their audit records.
          yield* transaction.execute(
            `UPDATE ${databaseTable("account_claim")} SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`,
            [now, user.id]
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("account_claim")} (id, user_id, token_hash, proof_method, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              user.id,
              tokenHash(token),
              input.method,
              input.actorId,
              expiresAt,
              now,
            ]
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'account.claim.issued', ?, ?)`,
            [
              user.id,
              JSON.stringify({
                actorId: input.actorId,
                claimId: id,
                method: input.method,
              }),
              now,
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
    expiresAt: new Date(expiresAt).toISOString(),
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
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.queryRows<ClaimRow>(
        "account.claim.preflight",
        `SELECT id FROM ${databaseTable("account_claim")} WHERE token_hash = ?
        AND consumed_at IS NULL AND expires_at > ? LIMIT 1`,
        [tokenHash(input.token), now]
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
            const now = yield* Clock.currentTimeMillis
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
            const nowDate = new Date(now)
            if (
              !user ||
              !claim ||
              claim.consumed_at ||
              claim.expires_at <= now ||
              (yield* hasCredentials(transaction, user.id))
            ) {
              return yield* Effect.fail(
                new Error("This account claim is invalid or expired")
              )
            }
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("account")} (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
              [randomUUID(), user.id, user.id, password, nowDate, nowDate]
            )
            yield* transaction.execute(
              claim.proof_method === "email"
                ? `UPDATE ${databaseTable("user")} SET name = ?, emailVerified = TRUE, emailVerifiedAt = ?, updatedAt = ? WHERE id = ?`
                : `UPDATE ${databaseTable("user")} SET name = ?, manuallyVerifiedAt = ?, manuallyVerifiedBy = ?, updatedAt = ? WHERE id = ?`,
              claim.proof_method === "email"
                ? [name, nowDate, nowDate, user.id]
                : [name, nowDate, claim.created_by, nowDate, user.id]
            )
            yield* transaction.execute(
              `UPDATE ${databaseTable("account_claim")} SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`,
              [now, user.id]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'account.claim.redeemed', ?, ?)`,
              [
                user.id,
                JSON.stringify({
                  actorId: user.id,
                  issuerId: claim.created_by,
                  claimId: claim.id,
                  method: claim.proof_method,
                }),
                now,
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

interface InvitedAccountRow extends RowDataPacket {
  id: string
  user_id: string
  invited_by: string | null
  expires_at: number
  accepted_at: number | null
  declined_at: number | null
  revoked_at: number | null
  cancelled_at: number | null
}

const INVITATION_UNAVAILABLE =
  "This invitation is invalid, expired, or already used"

// The invitation link is the authority to set up the account it names, as a
// claim's link is. The emailed link's key proves the mailbox. A link the
// inviter shared (their token, or the access table's share key) proves only
// that the inviter vouched for whoever opens it, so it's recorded as their
// manual verification. Either way, it works once: the account has a password
// afterwards, and accepting ends the invitation.
function invitationLookup(reference: InvitationReference) {
  if ("token" in reference)
    return {
      column: "token_hash",
      value: tokenHash(reference.token),
      proof: "manual" as const,
    }
  const purpose = invitationLinkPurpose(reference.id, reference.key)
  if (!purpose) return null
  return {
    column: "id",
    value: reference.id,
    proof: purpose === "email" ? ("email" as const) : ("manual" as const),
  }
}

function invitationIsOpen(row: InvitedAccountRow, now: number) {
  return (
    !row.accepted_at &&
    !row.declined_at &&
    !row.revoked_at &&
    !row.cancelled_at &&
    Number(row.expires_at) > now
  )
}

export async function redeemInvitedAccount(input: {
  invitation: InvitationReference
  password: string
  displayName: string
}) {
  const name = parseDisplayName(input.displayName)
  if (input.password.length < 12 || input.password.length > 128)
    throw new Error("Password must contain 12–128 characters")
  const lookup = invitationLookup(input.invitation)
  if (!lookup) throw new Error(INVITATION_UNAVAILABLE)
  const select = `SELECT id, user_id, invited_by, expires_at, accepted_at, declined_at, revoked_at, cancelled_at
    FROM ${databaseTable("invitation")} WHERE ${lookup.column} = ? LIMIT 1`
  // Reject a dead link or a set-up account before hashing the password.
  await runAppEffect(
    "account.invitation.preflight",
    Effect.gen(function* () {
      const database = yield* Database
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.queryRows<InvitedAccountRow>(
        "account.invitation.preflight",
        select,
        [lookup.value]
      )
      if (!rows[0] || !invitationIsOpen(rows[0], now))
        return yield* Effect.fail(new Error(INVITATION_UNAVAILABLE))
    })
  )
  const [context, { wakeAuthorizationDelivery }] = await Promise.all([
    auth.$context,
    import("@/lib/authorization-delivery"),
  ])
  const password = await context.password.hash(input.password)
  const result = await runAppEffect(
    "account.invitation.redeem",
    Effect.gen(function* () {
      const database = yield* Database
      return yield* database.transaction(
        "account.invitation.redeem",
        (transaction) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const candidates = yield* transaction.queryRows<InvitedAccountRow>(
              select,
              [lookup.value]
            )
            if (!candidates[0])
              return yield* Effect.fail(new Error(INVITATION_UNAVAILABLE))
            const users = yield* transaction.queryRows<
              ClaimUser & AccountPolicy
            >(
              `SELECT id, email, emailVerifiedAt, manuallyVerifiedAt, legacyVerificationRecordedAt
                 FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
              [candidates[0].user_id]
            )
            const invitations = yield* transaction.queryRows<InvitedAccountRow>(
              `${select} FOR UPDATE`,
              [lookup.value]
            )
            const user = users[0]
            const invitation = invitations[0]
            if (
              !user ||
              !invitation ||
              invitation.user_id !== user.id ||
              !invitationIsOpen(invitation, now)
            )
              return yield* Effect.fail(new Error(INVITATION_UNAVAILABLE))
            if (yield* hasCredentials(transaction, user.id))
              return yield* Effect.fail(
                new Error(
                  "This account is already set up. Sign in to accept the invitation."
                )
              )
            const nowDate = new Date(now)
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("account")} (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
              [randomUUID(), user.id, user.id, password, nowDate, nowDate]
            )
            // An inviter's vouching adds nothing to evidence the account
            // already has.
            const vouched =
              lookup.proof === "manual" && !isAccountVerified(user)
            yield* transaction.execute(
              lookup.proof === "email"
                ? `UPDATE ${databaseTable("user")} SET name = ?, emailVerified = TRUE, emailVerifiedAt = ?, updatedAt = ? WHERE id = ?`
                : vouched
                  ? `UPDATE ${databaseTable("user")} SET name = ?, manuallyVerifiedAt = ?, manuallyVerifiedBy = ?, updatedAt = ? WHERE id = ?`
                  : `UPDATE ${databaseTable("user")} SET name = ?, updatedAt = ? WHERE id = ?`,
              lookup.proof === "email"
                ? [name, nowDate, nowDate, user.id]
                : vouched
                  ? [name, nowDate, invitation.invited_by, nowDate, user.id]
                  : [name, nowDate, user.id]
            )
            // Any setup link already sent for this account is spent too.
            yield* transaction.execute(
              `UPDATE ${databaseTable("account_claim")} SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`,
              [now, user.id]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'account.invitation.redeemed', ?, ?)`,
              [
                user.id,
                JSON.stringify({
                  actorId: user.id,
                  invitationId: invitation.id,
                  inviterId: invitation.invited_by,
                  method: lookup.proof,
                }),
                now,
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
