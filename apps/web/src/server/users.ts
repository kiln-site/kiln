import { createServerFn } from "@tanstack/react-start"
import { Clock, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { advanceSubjectAcrossEnabledRelaysEffect } from "@/lib/authorization-revision"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { exclusive, userKey } from "@/operations/lanes"
import {
  operation,
  platformAdministrator,
  runOperationPromise,
} from "@/operations/operation"
import {
  assertRequestRateLimit,
  requestClientAddress,
} from "@/lib/request-rate-limit"
import {
  requireAuthenticatedUser,
  requireEligibleResourceUser,
} from "@/server/auth"
import {
  getUserAccessHandler,
  listManagedUsersHandler,
} from "@/server/users.server"

export type { ManagedUser, UserAccess } from "@/server/users.server"
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
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .default({ offset: 0, limit: 50 })
  )
  .handler(async ({ data }) =>
    listManagedUsersHandler(await requireEligibleResourceUser(), data)
  )

// One user's access across every resource, for the Manage user dialog.
export const getUserAccess = createServerFn({ method: "GET" })
  .validator(subjectSchema)
  .handler(async ({ data }) =>
    getUserAccessHandler(await requireEligibleResourceUser(), data.userId)
  )

const userStatusSchema = subjectSchema.extend({
  status: z.enum(["enabled", "disabled"]),
  reason: z.string().trim().max(1000).optional(),
})

const changeUserStatus = operation<z.infer<typeof userStatusSchema>>()({
  name: "user.status",
  doing: "Changing this person's account",
  authorize: ({ user }) => platformAdministrator(user),
  locks: ({ input }) => [exclusive(userKey(input.userId))],
  run: ({ input: data, context: actor }) =>
    Effect.gen(function* () {
      const change = yield* Effect.gen(function* () {
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
            const now = yield* Clock.currentTimeMillis
            yield* transaction.execute(
              `UPDATE ${databaseTable("user")} SET status = ?, statusChangedAt = ?,
           statusChangedBy = ?, statusReason = ?, statusExpiresAt = NULL, updatedAt = ? WHERE id = ?`,
              [
                data.status,
                new Date(now),
                actor.id,
                data.reason || null,
                new Date(now),
                subject.id,
              ]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'account.status.changed', ?, ?)`,
              [
                subject.id,
                JSON.stringify({
                  actorId: actor.id,
                  oldStatus: subject.status,
                  status: data.status,
                  reason: data.reason ?? null,
                }),
                now,
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
      yield* promiseEffect(() =>
        publishUserChange(data.userId, change?.relayIds ?? [])
      )
      return { status: data.status }
    }),
  audit: ({ input }) => ({ id: input.userId, kind: "user" }),
})

export const setUserStatus = createServerFn({ method: "POST" })
  .validator(userStatusSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeUserStatus, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const verifyUser = operation<z.infer<typeof subjectSchema>>()({
  name: "user.verify",
  doing: "Changing this person's account",
  authorize: ({ user }) => platformAdministrator(user),
  locks: ({ input }) => [exclusive(userKey(input.userId))],
  run: ({ input: data, context: actor }) =>
    Effect.gen(function* () {
      const change = yield* Effect.gen(function* () {
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
            const now = yield* Clock.currentTimeMillis
            yield* transaction.execute(
              `UPDATE ${databaseTable("user")} SET manuallyVerifiedAt = ?,
           manuallyVerifiedBy = ?, updatedAt = ? WHERE id = ?`,
              [new Date(now), actor.id, new Date(now), data.userId]
            )
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'account.manually-verified', ?, ?)`,
              [data.userId, JSON.stringify({ actorId: actor.id }), now]
            )
            return yield* advanceSubjectAcrossEnabledRelaysEffect(
              transaction,
              data.userId,
              [{ kind: "subject_relay" }]
            )
          })
        )
      })
      yield* promiseEffect(() =>
        publishUserChange(data.userId, change?.relayIds ?? [])
      )
      return { verified: true as const }
    }),
  audit: ({ input }) => ({ id: input.userId, kind: "user" }),
})

export const manuallyVerifyUser = createServerFn({ method: "POST" })
  .validator(subjectSchema)
  .handler(async ({ data }) =>
    runOperationPromise(verifyUser, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const issueClaim = operation<z.infer<typeof subjectSchema>>()({
  name: "user.claim.issue",
  doing: "Changing this person's account",
  authorize: ({ user }) => platformAdministrator(user),
  locks: ({ input }) => [exclusive(userKey(input.userId))],
  run: ({ context: actor, input }) =>
    promiseEffect(async () => {
      const { issueManualAccountClaim } = await import("@/lib/account-claims")
      return issueManualAccountClaim({
        userId: input.userId,
        actorId: actor.id,
        developmentBypass: actor.isDevelopmentBypass,
      })
    }),
  audit: ({ input }) => ({ id: input.userId, kind: "user" }),
})

export const issueAccountClaim = createServerFn({ method: "POST" })
  .validator(subjectSchema)
  .handler(async ({ data }) =>
    runOperationPromise(issueClaim, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const requestAccountClaim = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.email().transform((email) => email.trim().toLowerCase()),
      returnPath: z.string().max(2048).optional(),
    })
  )
  .handler(async ({ data }) => {
    const address = await requestClientAddress()
    assertRequestRateLimit(`account.claim:${address}`, 5, 10 * 60_000)
    assertRequestRateLimit(`account.claim:${data.email}`, 3, 10 * 60_000)
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
    // Sign-up itself reveals whether an address exists; this only bounds probing.
    const address = await requestClientAddress()
    assertRequestRateLimit(`account.signup.prepare:${address}`, 20, 10 * 60_000)
    const { accountNeedsClaim } = await import("@/lib/account-claims")
    return { claimRequired: await accountNeedsClaim(data.email) }
  })

export const getAccountClaimPreview = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().regex(/^[a-f0-9]{64}$/u) }))
  .handler(async ({ data }) => {
    const { setResponseHeader } = await import("@tanstack/react-start/server")
    setResponseHeader("Cache-Control", "no-store")
    const { previewAccountClaim } = await import("@/lib/account-claims")
    return previewAccountClaim(data.token)
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
  publishRealtimeChange({
    type: "hearth.invalidate",
    audience: { kind: "platform-admins" },
    topics: ["access"],
  })
}
