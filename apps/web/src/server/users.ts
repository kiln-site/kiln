import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { advanceSubjectAcrossEnabledRelaysEffect } from "@/lib/authorization-revision"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  requireAuthenticatedUser,
  requireEligibleResourceUser,
} from "@/server/auth"

export interface ManagedUser {
  id: string
  name: string
  email: string
  role: string
  status: "enabled" | "disabled"
  statusChangedAt: string | null
  statusChangedBy: string | null
  statusReason: string | null
  statusExpiresAt: string | null
  emailVerified: boolean
  emailVerifiedAt: string | null
  manuallyVerifiedAt: string | null
  manuallyVerifiedBy: string | null
  legacyVerificationRecordedAt: string | null
  createdAt: string
  updatedAt: string
  hasCredential: boolean
}
interface UserRow extends RowDataPacket {
  id: string
  name: string
  email: string
  role: string
  status: "enabled" | "disabled"
  statusChangedAt: Date | null
  statusChangedBy: string | null
  statusReason: string | null
  statusExpiresAt: Date | null
  emailVerified: number
  emailVerifiedAt: Date | null
  manuallyVerifiedAt: Date | null
  manuallyVerifiedBy: string | null
  legacyVerificationRecordedAt: Date | null
  createdAt: Date
  updatedAt: Date
  hasCredential: number
}
const subjectSchema = z.object({ userId: z.string().min(1).max(36) })

export const getAccountStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return requireAuthenticatedUser()
  }
)

export const listUsers = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        search: z.string().trim().max(160).optional(),
        status: z.enum(["enabled", "disabled"]).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .default({ offset: 0, limit: 50 })
  )
  .handler(async ({ data }) => {
    const actor = await requireEligibleResourceUser()
    if (actor.role !== "admin")
      throw new Error("Platform administrator required")
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (data.search) {
      clauses.push("(u.email LIKE ? OR u.name LIKE ?)")
      const search = `%${data.search.replace(/[\\%_]/gu, "\\$&")}%`
      values.push(search, search)
    }
    if (data.status) {
      clauses.push(
        data.status === "disabled"
          ? "(u.status = 'disabled' AND (u.statusExpiresAt IS NULL OR u.statusExpiresAt > CURRENT_TIMESTAMP(3)))"
          : "(u.status = 'enabled' OR u.statusExpiresAt <= CURRENT_TIMESTAMP(3))"
      )
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    return runAppEffect(
      "users.list",
      Effect.gen(function* () {
        const database = yield* Database
        const rows = yield* database.queryRows<UserRow>(
          "users.list",
          `SELECT u.*, (EXISTS(SELECT 1 FROM ${databaseTable("account")} a WHERE a.userId=u.id)
             OR EXISTS(SELECT 1 FROM ${databaseTable("passkey")} p WHERE p.userId=u.id)) AS hasCredential
           FROM ${databaseTable("user")} u ${where}
          ORDER BY u.createdAt DESC, u.id LIMIT ? OFFSET ?`,
          [...values, data.limit, data.offset]
        )
        const count = yield* database.queryRows<RowDataPacket>(
          "users.count",
          `SELECT COUNT(*) AS count FROM ${databaseTable("user")} u ${where}`,
          values
        )
        return {
          users: rows.map(serializeUser),
          total: Number(count[0]?.count ?? 0),
        }
      })
    )
  })

export const setUserStatus = createServerFn({ method: "POST" })
  .validator(
    subjectSchema.extend({
      status: z.enum(["enabled", "disabled"]),
      reason: z.string().trim().max(1000).optional(),
    })
  )
  .handler(async ({ data }) => {
    const actor = await requireEligibleResourceUser()
    if (actor.role !== "admin")
      throw new Error("Platform administrator required")
    const change = await runAppEffect(
      "users.status",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction("users.status", (transaction) =>
          Effect.gen(function* () {
            // Lock the administrator set in the same order as role changes.
            const admins = yield* transaction.queryRows<UserRow>(
              `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
            )
            const currentActor = admins.find((admin) => admin.id === actor.id)
            if (
              !actor.isDevelopmentBypass &&
              (!currentActor ||
                !isAccountEnabled(currentActor) ||
                !isAccountVerified(currentActor))
            ) {
              return yield* Effect.fail(
                new Error("Platform administrator required")
              )
            }
            const rows = yield* transaction.queryRows<UserRow>(
              `SELECT * FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
              [data.userId]
            )
            const subject = rows[0]
            if (!subject) return yield* Effect.fail(new Error("User not found"))
            if (
              data.status === "disabled" &&
              subject.role === "admin" &&
              !admins.some(
                (admin) =>
                  admin.id !== subject.id &&
                  isAccountEnabled(admin) &&
                  isAccountVerified(admin)
              )
            ) {
              return yield* Effect.fail(
                new Error(
                  "Keep at least one enabled, verified platform administrator"
                )
              )
            }
            if (subject.status === data.status && !subject.statusExpiresAt)
              return null
            yield* transaction.execute(
              `UPDATE ${databaseTable("user")} SET status = ?, statusChangedAt = CURRENT_TIMESTAMP(3),
             statusChangedBy = ?, statusReason = ?, statusExpiresAt = NULL, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
              [data.status, actor.id, data.reason || null, subject.id]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'account.status.changed', ?)`,
              [
                subject.id,
                JSON.stringify({
                  actorId: actor.id,
                  oldStatus: subject.status,
                  status: data.status,
                  reason: data.reason ?? null,
                }),
              ]
            )
            return yield* advanceSubjectAcrossEnabledRelaysEffect(
              transaction,
              subject.id,
              [{ kind: "subject_relay" }]
            )
          })
        )
      })
    )
    await publishUserChange(data.userId, change?.relayIds ?? [])
    return { status: data.status }
  })

export const manuallyVerifyUser = createServerFn({ method: "POST" })
  .validator(subjectSchema)
  .handler(async ({ data }) => {
    const actor = await requireEligibleResourceUser()
    if (actor.role !== "admin")
      throw new Error("Platform administrator required")
    const change = await runAppEffect(
      "users.verify",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction("users.verify", (transaction) =>
          Effect.gen(function* () {
            const admins = yield* transaction.queryRows<UserRow>(
              `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
            )
            if (
              !actor.isDevelopmentBypass &&
              !admins.some(
                (admin) =>
                  admin.id === actor.id &&
                  isAccountEnabled(admin) &&
                  isAccountVerified(admin)
              )
            ) {
              return yield* Effect.fail(
                new Error("Platform administrator required")
              )
            }
            const rows = yield* transaction.queryRows<UserRow>(
              `SELECT * FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
              [data.userId]
            )
            if (!rows[0]) return yield* Effect.fail(new Error("User not found"))
            if (rows[0].manuallyVerifiedAt) return null
            yield* transaction.execute(
              `UPDATE ${databaseTable("user")} SET manuallyVerifiedAt = CURRENT_TIMESTAMP(3),
             manuallyVerifiedBy = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
              [actor.id, data.userId]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'account.manually-verified', ?)`,
              [data.userId, JSON.stringify({ actorId: actor.id })]
            )
            return yield* advanceSubjectAcrossEnabledRelaysEffect(
              transaction,
              data.userId,
              [{ kind: "subject_relay" }]
            )
          })
        )
      })
    )
    await publishUserChange(data.userId, change?.relayIds ?? [])
    return { verified: true }
  })

export const issueAccountClaim = createServerFn({ method: "POST" })
  .validator(subjectSchema)
  .handler(async ({ data }) => {
    const actor = await requireEligibleResourceUser()
    if (actor.role !== "admin")
      throw new Error("Platform administrator required")
    const { issueManualAccountClaim } = await import("@/lib/account-claims")
    return issueManualAccountClaim({
      userId: data.userId,
      actorId: actor.id,
      developmentBypass: actor.isDevelopmentBypass,
    })
  })

export const requestAccountClaim = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.email().transform((email) => email.trim().toLowerCase()),
      returnPath: z.string().max(2048).optional(),
    })
  )
  .handler(async ({ data }) => {
    const { requestEmailAccountClaim } = await import("@/lib/account-claims")
    await requestEmailAccountClaim(data.email, data.returnPath)
    return { sent: true }
  })

export const prepareAccountSignup = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.email().transform((email) => email.trim().toLowerCase()),
    })
  )
  .handler(async ({ data }) => {
    const { accountNeedsClaim } = await import("@/lib/account-claims")
    return { claimRequired: await accountNeedsClaim(data.email) }
  })

export const claimAccount = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/u),
      password: z.string().min(12).max(128),
      displayName: z.string().trim().min(1).max(16),
    })
  )
  .handler(async ({ data }) => {
    const { redeemAccountClaim } = await import("@/lib/account-claims")
    return redeemAccountClaim(data)
  })

function serializeUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: isAccountEnabled(row) ? "enabled" : "disabled",
    statusChangedAt: iso(row.statusChangedAt),
    statusChangedBy: row.statusChangedBy,
    statusReason: row.statusReason,
    statusExpiresAt: iso(row.statusExpiresAt),
    emailVerified: Boolean(row.emailVerified),
    emailVerifiedAt: iso(row.emailVerifiedAt),
    manuallyVerifiedAt: iso(row.manuallyVerifiedAt),
    manuallyVerifiedBy: row.manuallyVerifiedBy,
    legacyVerificationRecordedAt: iso(row.legacyVerificationRecordedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasCredential: Boolean(row.hasCredential),
  }
}
function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null
}
async function publishUserChange(
  userId: string,
  relayIds: ReadonlyArray<string>
) {
  const { wakeAuthorizationDelivery } =
    await import("@/lib/authorization-delivery")
  for (const relayId of relayIds) wakeAuthorizationDelivery(relayId)
  publishRealtimeChange({
    type: "access.changed",
    reauthenticate: true,
    userIds: [userId],
  })
}
