import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { loadResourceGrantsEffect } from "@/lib/resource-permissions"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { Database } from "@/effect/database"
import { PermissionDeniedError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import type {
  AccessPermission,
  AccessRole,
  PlatformPermission,
} from "@/lib/permissions"
import {
  platformRoleHasPermission,
  grantHasPermission,
} from "@/lib/permissions"

interface DeletedInstanceGrantRow extends RowDataPacket {
  user_id: string
}

interface FreshAuthorizationUserRow extends RowDataPacket {
  status: "enabled" | "disabled"
  statusExpiresAt: Date | null
  emailVerifiedAt: Date | null
  manuallyVerifiedAt: Date | null
  legacyVerificationRecordedAt: Date | null
  revision: string
  role: string | null
  session_id: string | null
}

export interface AccessGrant {
  id: string
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
  role: AccessRole
  permissions?: Array<AccessPermission>
  source?: "access" | "owner"
}

export function deduplicateEffectiveInstanceGrants<
  TGrant extends {
    resourceType: "instance" | "relay"
    userId: string
  },
>(grants: Iterable<TGrant>): Array<TGrant> {
  const grantsByUserId = new Map<string, TGrant>()
  for (const grant of grants) {
    const existingGrant = grantsByUserId.get(grant.userId)
    if (existingGrant?.resourceType === "instance") continue
    if (!existingGrant || grant.resourceType === "instance") {
      grantsByUserId.set(grant.userId, grant)
    }
  }
  return [...grantsByUserId.values()]
}

export function isCurrentInstanceOwnerGrant(input: {
  grantUserId: string | null
  ownerId: string | null
}): boolean {
  return input.ownerId !== null && input.ownerId === input.grantUserId
}

export function isProtectedInstanceOwnerGrant(input: {
  grantRole: string | null
  grantUserId: string | null
  ownerId: string | null
}): boolean {
  return input.grantRole === "owner" || isCurrentInstanceOwnerGrant(input)
}

export function isBlockedInstanceOwnerRoleChange(input: {
  grantRole: string | null
  grantUserId: string | null
  nextRole: string
  ownerId: string | null
}): boolean {
  return (
    input.nextRole !== input.grantRole &&
    input.nextRole !== "owner" &&
    isCurrentInstanceOwnerGrant(input)
  )
}

export function accessGrantRoleChangeError(input: {
  canManageOwners: boolean
  currentRole: string | null
  nextRole: string
  ownerId: string | null
  userId: string
}): Error | null {
  if (
    (input.currentRole === "owner" || input.nextRole === "owner") &&
    !input.canManageOwners
  ) {
    return new Error(
      "Only a Relay owner or platform admin can change owner access"
    )
  }
  if (
    isBlockedInstanceOwnerRoleChange({
      grantRole: input.currentRole,
      grantUserId: input.userId,
      nextRole: input.nextRole,
      ownerId: input.ownerId,
    })
  ) {
    return new Error(
      "Transfer ownership before changing the server owner's role"
    )
  }
  return null
}

export async function listUserGrants(
  userId: string,
  relayId?: string
): Promise<Array<AccessGrant>> {
  return runAppEffect(
    "access.listUserGrants",
    listUserGrantsEffect(userId, relayId)
  )
}

export const listUserGrantsEffect = loadResourceGrantsEffect

export function isPlatformAdmin(user: AuthenticatedUser): boolean {
  return user.isDevelopmentBypass || user.role === "admin"
}

export function isRelayCreator(user: AuthenticatedUser): boolean {
  return !user.isDevelopmentBypass && user.role === "relay_creator"
}

export function visibleRelaysForUser<
  TRelay extends { createdBy: string | null; id: string },
>(
  user: AuthenticatedUser,
  relays: ReadonlyArray<TRelay>,
  grants: Iterable<Pick<AccessGrant, "relayId">>
): Array<TRelay> {
  if (isPlatformAdmin(user)) return [...relays]
  const grantedRelayIds = new Set(Array.from(grants, (grant) => grant.relayId))
  return relays.filter(
    (relay) =>
      grantedRelayIds.has(relay.id) ||
      (isRelayCreator(user) && relay.createdBy === user.id)
  )
}

export function hasPlatformPermission(
  user: AuthenticatedUser,
  permission: PlatformPermission
): boolean {
  return (
    isAccountEnabled(user) &&
    isAccountVerified(user) &&
    (user.isDevelopmentBypass ||
      platformRoleHasPermission(user.role, permission))
  )
}

export async function hasRelayPermission(input: {
  user: AuthenticatedUser
  relayId: string
  permission: AccessPermission
  databaseId?: string
  instanceId?: string
}): Promise<boolean> {
  if (!isAccountEnabled(input.user) || !isAccountVerified(input.user))
    return false
  if (isPlatformAdmin(input.user)) return true
  const grants = await listUserGrants(input.user.id, input.relayId)
  return grants.some((grant) => {
    if (!grantHasPermission(grant, input.permission)) return false
    if (grant.resourceType === "relay") return true
    return Boolean(
      (grant.resourceType === "instance" &&
        input.instanceId &&
        grant.resourceId === input.instanceId) ||
      (grant.resourceType === "database" &&
        input.databaseId &&
        grant.resourceId === input.databaseId)
    )
  })
}

export async function requireRelayPermission(input: {
  user: AuthenticatedUser
  relayId: string
  permission: AccessPermission
  databaseId?: string
  instanceId?: string
}): Promise<void> {
  return runAppEffect(
    "access.requireRelayPermission",
    requireRelayPermissionEffect(input)
  )
}

export const requireRelayPermissionEffect = Effect.fn(
  "access.requireRelayPermission"
)(function* (input: {
  user: AuthenticatedUser
  relayId: string
  permission: AccessPermission
  databaseId?: string
  instanceId?: string
}) {
  return yield* requireRelayPermissionsEffect({
    ...input,
    permissions: [input.permission],
  })
})

export const requireRelayPermissionsEffect = Effect.fn(
  "access.requireRelayPermissions"
)(function* (input: {
  user: AuthenticatedUser
  relayId: string
  permissions: ReadonlyArray<AccessPermission>
  databaseId?: string
  instanceId?: string
}) {
  if (input.permissions.length === 0) {
    return yield* PermissionDeniedError.make({
      message: "At least one permission is required",
    })
  }
  if (!isAccountEnabled(input.user) || !isAccountVerified(input.user)) {
    return yield* PermissionDeniedError.make({
      message: "Your account cannot access resources",
    })
  }
  if (isPlatformAdmin(input.user)) return
  const grants = yield* listUserGrantsEffect(
    input.user.id,
    input.relayId,
    undefined,
    {
      relayId: input.relayId,
      resourceType: input.instanceId
        ? "instance"
        : input.databaseId
          ? "database"
          : "relay",
      resourceId: input.instanceId ?? input.databaseId ?? input.relayId,
    }
  )
  const allowed = input.permissions.every((permission) =>
    grants.some((grant) => {
      if (!grantHasPermission(grant, permission)) return false
      if (grant.resourceType === "relay") return true
      return Boolean(
        (grant.resourceType === "instance" &&
          input.instanceId &&
          grant.resourceId === input.instanceId) ||
        (grant.resourceType === "database" &&
          input.databaseId &&
          grant.resourceId === input.databaseId)
      )
    })
  )
  if (!allowed) {
    return yield* PermissionDeniedError.make({
      message: "You do not have permission to perform this action",
    })
  }
})

/**
 * Refreshes the mutable authorization fields used during capability issuance.
 * The surrounding revision guard in the issuer detects any concurrent access
 * mutation, while this query prevents stale session/user objects from granting
 * platform authority after a role, ban, deletion, or session change.
 */
export const refreshRelayAuthorizationUserEffect = Effect.fn(
  "access.refreshRelayAuthorizationUser"
)(function* (input: {
  loginSession:
    | { id: string; kind: "better_auth" }
    | { id: string; kind: "cli_credential" }
    | null
  user: AuthenticatedUser
}) {
  if (input.user.isDevelopmentBypass) return { revision: 0, user: input.user }
  const database = yield* Database
  const rows = yield* database.queryRows<FreshAuthorizationUserRow>(
    "access.refreshRelayAuthorizationUser",
    `SELECT auth_user.role,
            auth_user.status, auth_user.statusExpiresAt,
            auth_user.emailVerifiedAt, auth_user.manuallyVerifiedAt,
            auth_user.legacyVerificationRecordedAt,
            CAST(COALESCE(auth_subject.revision, 0) AS CHAR) AS revision,
            ${
              input.loginSession?.kind === "better_auth"
                ? `(SELECT auth_session.id
                     FROM ${databaseTable("session")} AS auth_session
                    WHERE auth_session.id = ?
                      AND auth_session.userId = auth_user.id
                      AND auth_session.expiresAt > CURRENT_TIMESTAMP(3)
                    LIMIT 1)`
                : input.loginSession?.kind === "cli_credential"
                  ? `(SELECT cli_credential.id
                       FROM ${databaseTable("cli_credential")} AS cli_credential
                      WHERE cli_credential.id = ?
                        AND cli_credential.user_id = auth_user.id
                        AND cli_credential.revoked_at IS NULL
                        AND (
                          cli_credential.expires_at IS NULL OR
                          cli_credential.expires_at > CURRENT_TIMESTAMP(3)
                        )
                      LIMIT 1)`
                  : "NULL"
            } AS session_id
       FROM ${databaseTable("user")} AS auth_user
       LEFT JOIN ${databaseTable("authorization_subject")} AS auth_subject
         ON auth_subject.user_id = auth_user.id
      WHERE auth_user.id = ?
      LIMIT 1`,
    input.loginSession
      ? [input.loginSession.id, input.user.id]
      : [input.user.id]
  )
  const current = rows[0]
  const freshUser = current
    ? {
        ...input.user,
        status:
          current.status === "disabled" &&
          (!current.statusExpiresAt ||
            current.statusExpiresAt.getTime() > Date.now())
            ? ("disabled" as const)
            : ("enabled" as const),
        statusExpiresAt: current.statusExpiresAt?.toISOString() ?? null,
        emailVerifiedAt: current.emailVerifiedAt?.toISOString() ?? null,
        manuallyVerifiedAt: current.manuallyVerifiedAt?.toISOString() ?? null,
        legacyVerificationRecordedAt:
          current.legacyVerificationRecordedAt?.toISOString() ?? null,
      }
    : null
  if (
    !current ||
    !freshUser ||
    !isAccountEnabled(freshUser) ||
    !isAccountVerified(freshUser) ||
    (input.loginSession && current.session_id !== input.loginSession.id)
  ) {
    return yield* PermissionDeniedError.make({
      message: "Your session is no longer authorized",
    })
  }
  const role: AuthenticatedUser["role"] =
    current.role === "admin" || current.role === "relay_creator"
      ? current.role
      : "user"
  const revision = Number(current.revision)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return yield* Effect.fail(
      new Error("Authorization revision is outside the safe integer range")
    )
  }
  return { revision, user: { ...freshUser, role } }
})

export async function allowedInstanceIds(
  user: AuthenticatedUser,
  relayId: string,
  instanceIds: Array<string>
): Promise<Set<string>> {
  return runAppEffect(
    "access.allowedInstanceIds",
    allowedInstanceIdsEffect(user, relayId, instanceIds)
  )
}

export const allowedInstanceIdsEffect = Effect.fn("access.allowedInstanceIds")(
  function* (
    user: AuthenticatedUser,
    relayId: string,
    instanceIds: Array<string>
  ) {
    if (!isAccountEnabled(user) || !isAccountVerified(user))
      return new Set<string>()
    if (isPlatformAdmin(user)) return new Set(instanceIds)
    const grants = yield* listUserGrantsEffect(user.id, relayId)
    return allowedInstanceIdsForUser(user, relayId, instanceIds, grants)
  }
)

export function canReadRelayNode(
  user: AuthenticatedUser,
  relayId: string,
  grants: ReadonlyArray<AccessGrant>
): boolean {
  if (!isAccountEnabled(user) || !isAccountVerified(user)) return false
  return (
    isPlatformAdmin(user) ||
    grants.some(
      (grant) =>
        grant.relayId === relayId &&
        grant.resourceType === "relay" &&
        grantHasPermission(grant, "relay.read")
    )
  )
}

export function allowedInstanceIdsForUser(
  user: AuthenticatedUser,
  relayId: string,
  instanceIds: Array<string>,
  grants: ReadonlyArray<AccessGrant>
): Set<string> {
  if (!isAccountEnabled(user) || !isAccountVerified(user))
    return new Set<string>()
  if (isPlatformAdmin(user)) return new Set(instanceIds)
  const relayGrants = grants.filter((grant) => grant.relayId === relayId)
  if (
    relayGrants.some(
      (grant) =>
        grant.resourceType === "relay" &&
        grantHasPermission(grant, "instance.read")
    )
  ) {
    return new Set(instanceIds)
  }
  return new Set(
    relayGrants.flatMap((grant) =>
      grant.resourceType === "instance" &&
      grantHasPermission(grant, "instance.read")
        ? [grant.resourceId]
        : []
    )
  )
}

export const deleteInstanceAccessEffect = Effect.fn("access.deleteInstance")(
  function* (relayId: string, instanceId: string) {
    const database = yield* Database
    const changed = yield* database.transaction(
      "access.deleteInstance",
      (transaction) =>
        Effect.gen(function* () {
          const grants = yield* transaction.queryRows<DeletedInstanceGrantRow>(
            `SELECT user_id
             FROM ${databaseTable("access_grant")}
            WHERE relay_id = ? AND resource_type = 'instance' AND resource_id = ?
            FOR UPDATE`,
            [relayId, instanceId]
          )
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("access_grant")}
        WHERE relay_id = ? AND resource_type = 'instance' AND resource_id = ?`,
            [relayId, instanceId]
          )
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("invitation")}
        WHERE relay_id = ? AND instance_id = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP(3)`,
            [relayId, instanceId]
          )
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("permission_preset")}
              WHERE relay_id = ? AND resource_type = 'instance' AND resource_id = ?`,
            [relayId, instanceId]
          )
          for (const grant of grants) {
            yield* advanceAuthorizationRevisionEffect(transaction, {
              targets: [
                {
                  relayId,
                  scope: { instanceId, kind: "instance" },
                },
              ],
              userId: grant.user_id,
            })
          }
          return grants.length > 0
        })
    )
    if (changed) {
      yield* Effect.promise(async () => {
        const { wakeAuthorizationDelivery } =
          await import("@/lib/authorization-delivery")
        wakeAuthorizationDelivery(relayId)
      })
    }
  }
)
