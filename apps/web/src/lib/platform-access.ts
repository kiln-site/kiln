import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { isPlatformAdmin } from "@/lib/access-control"
import {
  lockAccessActorEffect,
  lockAccessScopeEffect,
} from "@/lib/access-policy-mutations"
import {
  isAccountEnabled,
  isAccountVerified,
  type AccountPolicy,
} from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  advanceAuthorizationRevisionEffect,
  advanceSubjectAcrossEnabledRelaysEffect,
} from "@/lib/authorization-revision"
import { databaseTable } from "@/lib/database-config"

interface PlatformRoleUserRow extends RowDataPacket, AccountPolicy {
  id: string
  email: string
  role: string | null
}
interface InstanceOwnerGrantRow extends RowDataPacket {
  user_id: string
}

export function assignPlatformAccessEffect(input: {
  accessType: "platform_admin" | "relay_creator"
  actingUserId: string
  developmentBypass: boolean
  userId: string
}) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(
      "access.platform.assign",
      (transaction) =>
        Effect.gen(function* () {
          const admins = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT *
               FROM ${databaseTable("user")}
              WHERE role = 'admin'
              ORDER BY id
              FOR UPDATE`
          )
          if (
            !input.developmentBypass &&
            !admins.some(
              (admin) =>
                admin.id === input.actingUserId &&
                isAccountEnabled(admin) &&
                isAccountVerified(admin)
            )
          ) {
            return yield* Effect.fail(
              new Error(
                "Only a platform administrator can assign platform access"
              )
            )
          }

          const users = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT *
               FROM ${databaseTable("user")}
              WHERE id = ? LIMIT 1 FOR UPDATE`,
            [input.userId]
          )
          const target = users.at(0)
          if (!target) return yield* Effect.fail(new Error("User not found"))
          if (
            input.accessType === "relay_creator" &&
            target.role === "admin" &&
            !admins.some(
              (admin) =>
                admin.id !== target.id &&
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

          const platformRole =
            input.accessType === "platform_admin" ? "admin" : "relay_creator"
          yield* transaction.execute(
            `UPDATE ${databaseTable("user")} SET role = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
            [platformRole, input.userId]
          )
          if (target.role !== platformRole) {
            yield* advancePlatformAuthorization(
              transaction,
              input.userId,
              input.actingUserId,
              target.role,
              platformRole
            )
          }
        })
    )
  })
}

export function removePlatformAccessEffect(input: {
  actingUserId: string
  developmentBypass: boolean
  targetUserId: string
}) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(
      "access.platform.remove",
      (transaction) =>
        Effect.gen(function* () {
          const admins = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT *
               FROM ${databaseTable("user")}
              WHERE role = 'admin'
              ORDER BY id
              FOR UPDATE`
          )
          if (
            !input.developmentBypass &&
            !admins.some(
              (admin) =>
                admin.id === input.actingUserId &&
                isAccountEnabled(admin) &&
                isAccountVerified(admin)
            )
          ) {
            return yield* Effect.fail(
              new Error(
                "Only a platform administrator can remove platform access"
              )
            )
          }

          const users = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT *
               FROM ${databaseTable("user")}
              WHERE id = ? LIMIT 1 FOR UPDATE`,
            [input.targetUserId]
          )
          const target = users.at(0)
          if (
            !target ||
            (target.role !== "admin" && target.role !== "relay_creator")
          ) {
            return { removed: true }
          }
          if (
            target.role === "admin" &&
            !admins.some(
              (admin) =>
                admin.id !== target.id &&
                isAccountEnabled(admin) &&
                isAccountVerified(admin)
            )
          ) {
            return yield* Effect.fail(
              new Error("At least one Platform Admin is required")
            )
          }

          yield* transaction.execute(
            `UPDATE ${databaseTable("user")} SET role = 'user', updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
            [target.id]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("invitation")}
                SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ?
              WHERE user_id = ?
                AND access_type <> 'scoped'
                AND accepted_at IS NULL
                AND revoked_at IS NULL`,
            [input.actingUserId, target.id]
          )
          yield* advancePlatformAuthorization(
            transaction,
            target.id,
            input.actingUserId,
            target.role,
            "user"
          )
          return { removed: true }
        })
    )
  })
}

function advancePlatformAuthorization(
  transaction: DatabaseTransaction,
  userId: string,
  actorId: string,
  oldRole: string | null,
  role: string
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'platform.role.changed', ?)`,
      [userId, JSON.stringify({ actorId, oldRole, role })]
    )
    yield* advanceSubjectAcrossEnabledRelaysEffect(transaction, userId, [
      { kind: "subject_relay" },
    ])
  })
}

export function transferInstanceOwnershipEffect(
  user: AuthenticatedUser,
  data: { relayId: string; instanceId: string; userId: string }
) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(
      "access.instance.transferOwnership",
      (transaction) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(transaction, user)
          const resource = yield* lockAccessScopeEffect(transaction, {
            relayId: data.relayId,
            resourceType: "instance",
            resourceId: data.instanceId,
          })
          const ownerId = resource.owner_id
          if (!isPlatformAdmin(actor) && ownerId !== actor.id) {
            return yield* Effect.fail(
              new Error("Only the server owner can transfer ownership")
            )
          }
          if (ownerId === data.userId) {
            return yield* Effect.fail(
              new Error("This user already owns the server")
            )
          }

          const targets = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT * FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
            [data.userId]
          )
          const target = targets[0]
          if (
            !target ||
            !isAccountEnabled(target) ||
            !isAccountVerified(target)
          ) {
            return yield* Effect.fail(
              new Error("The new owner must have an enabled, verified account")
            )
          }
          const targetGrants =
            yield* transaction.queryRows<InstanceOwnerGrantRow>(
              `SELECT user_id FROM ${databaseTable("access_grant")} WHERE user_id = ? AND relay_id = ?
                  AND state = 'active' AND (resource_type = 'relay' OR (resource_type = 'instance' AND resource_id = ?)) LIMIT 1 FOR UPDATE`,
              [data.userId, data.relayId, data.instanceId]
            )
          if (target.role !== "admin" && !targetGrants[0])
            return yield* Effect.fail(
              new Error(
                "Give this user active server access before transferring ownership"
              )
            )

          yield* transaction.execute(
            `INSERT INTO ${databaseTable("instance")}
                   (relay_id, instance_id, display_name, owner_id)
                 VALUES (?, ?, NULL, ?)
                 ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id)`,
            [data.relayId, data.instanceId, data.userId]
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'instance.ownership.transferred', ?)`,
            [
              data.userId,
              JSON.stringify({
                actorId: actor.id,
                oldOwnerId: ownerId,
                relayId: data.relayId,
                instanceId: data.instanceId,
              }),
            ]
          )
          for (const changedUserId of [ownerId, data.userId]) {
            if (!changedUserId) continue
            yield* advanceAuthorizationRevisionEffect(transaction, {
              targets: [
                {
                  relayId: data.relayId,
                  scope: { instanceId: data.instanceId, kind: "instance" },
                },
              ],
              userId: changedUserId,
            })
          }
          return { transferred: true, previousOwnerId: ownerId }
        })
    )
  })
}

interface PlatformInvitationRow extends RowDataPacket {
  id: string
  user_id: string | null
  access_type: "scoped" | "platform_admin" | "relay_creator"
  accepted_at: Date | null
  revoked_at: Date | null
  declined_at: Date | null
  cancelled_at: Date | null
  expires_at: Date
}
function isPlatformInvitationPending(
  invitation: PlatformInvitationRow
): boolean {
  return (
    !invitation.accepted_at &&
    !invitation.revoked_at &&
    !invitation.declined_at &&
    !invitation.cancelled_at &&
    invitation.expires_at.getTime() > Date.now()
  )
}
export function acceptPlatformInvitationEffect(
  user: AuthenticatedUser,
  tokenHash: string
) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction("access.platform.accept", (tx) =>
      Effect.gen(function* () {
        yield* tx.queryRows<PlatformRoleUserRow>(
          `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
        )
        const subjects = yield* tx.queryRows<PlatformRoleUserRow>(
          `SELECT * FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
          [user.id]
        )
        const subject = subjects[0]
        if (
          !subject ||
          !isAccountEnabled(subject) ||
          !isAccountVerified(subject)
        )
          return yield* Effect.fail(
            new Error("An enabled, verified account is required")
          )
        const rows = yield* tx.queryRows<PlatformInvitationRow>(
          `SELECT * FROM ${databaseTable("invitation")} WHERE token_hash = ? FOR UPDATE`,
          [tokenHash]
        )
        const current = rows[0]
        if (
          !current ||
          !isPlatformInvitationPending(current) ||
          current.access_type === "scoped"
        )
          return yield* Effect.fail(
            new Error("This invitation is invalid or has expired")
          )
        if (current.user_id !== subject.id)
          return yield* Effect.fail(
            new Error("Sign in with the invited account")
          )
        const role =
          current.access_type === "platform_admin"
            ? "admin"
            : subject.role === "admin"
              ? "admin"
              : "relay_creator"
        yield* tx.execute(
          `UPDATE ${databaseTable("user")} SET role = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [role, user.id]
        )
        yield* tx.execute(
          `UPDATE ${databaseTable("invitation")} SET accepted_at = CURRENT_TIMESTAMP(3), accepted_by = ?, acceptance_method = 'self' WHERE id = ?`,
          [user.id, current.id]
        )
        yield* tx.execute(
          `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'platform.invitation.accepted', ?)`,
          [
            user.id,
            JSON.stringify({
              actorId: user.id,
              invitationId: current.id,
              oldRole: subject.role,
              role,
            }),
          ]
        )
        yield* advanceSubjectAcrossEnabledRelaysEffect(tx, user.id, [
          { kind: "subject_relay" },
        ])
      })
    )
  })
}
export function cancelPlatformInvitationEffect(
  user: AuthenticatedUser,
  invitationId: string
) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction("access.platform.cancel", (tx) =>
      Effect.gen(function* () {
        const admins = yield* tx.queryRows<PlatformRoleUserRow>(
          `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
        )
        if (
          !user.isDevelopmentBypass &&
          !admins.some(
            (admin) =>
              admin.id === user.id &&
              isAccountEnabled(admin) &&
              isAccountVerified(admin)
          )
        )
          return yield* Effect.fail(
            new Error("Platform administrator required")
          )
        const invitations = yield* tx.queryRows<PlatformInvitationRow>(
          `SELECT * FROM ${databaseTable("invitation")} WHERE id = ? AND relay_id IS NULL AND access_type <> 'scoped' FOR UPDATE`,
          [invitationId]
        )
        if (!invitations[0] || !isPlatformInvitationPending(invitations[0]))
          return yield* Effect.fail(
            new Error("This invitation is no longer pending")
          )
        yield* tx.execute(
          `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ? WHERE id = ?`,
          [user.id, invitationId]
        )
        yield* tx.execute(
          `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'platform.invitation.cancelled', ?)`,
          [
            invitations[0].user_id,
            JSON.stringify({ actorId: user.id, invitationId: invitationId }),
          ]
        )
      })
    )
  })
}
