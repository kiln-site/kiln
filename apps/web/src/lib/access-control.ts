import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { Database } from "@/effect/database"
import { PermissionDeniedError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import type {
  AccessPermission,
  AccessRole,
  PlatformPermission,
} from "@/lib/permissions"
import {
  isAccessRole,
  platformRoleHasPermission,
  roleHasPermission,
} from "@/lib/permissions"

interface GrantRow extends RowDataPacket {
  id: string
  relay_id: string
  resource_type: "database" | "instance" | "relay"
  resource_id: string
  role: string
}

interface InstanceOwnerRow extends RowDataPacket {
  owner_id: string | null
}

interface ScopedGrantRoleRow extends RowDataPacket {
  role: string
  user_id: string
}

export interface AccessGrant {
  id: string
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
  role: AccessRole
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

export const grantExistingUserAccessEffect = Effect.fn(
  "access.grantExistingUser"
)(function* (input: {
  canManageOwners: boolean
  email: string
  grantId: string
  grantedBy: string
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
  role: AccessRole
  userId: string
}) {
  const database = yield* Database
  return yield* database.transaction(
    "access.grantExistingUser",
    (transaction) =>
      Effect.gen(function* () {
        const ownerRows =
          input.resourceType === "instance"
            ? yield* transaction.queryRows<InstanceOwnerRow>(
                `SELECT owner_id FROM ${databaseTable("instance")}
                  WHERE relay_id = ? AND instance_id = ? LIMIT 1 FOR UPDATE`,
                [input.relayId, input.resourceId]
              )
            : []
        const grantRows = yield* transaction.queryRows<ScopedGrantRoleRow>(
          `SELECT user_id, role
               FROM ${databaseTable("access_grant")}
              WHERE user_id = ? AND relay_id = ?
                AND resource_type = ? AND resource_id = ?
              LIMIT 1 FOR UPDATE`,
          [input.userId, input.relayId, input.resourceType, input.resourceId]
        )
        const existingGrant = grantRows.at(0)
        const roleChangeError = accessGrantRoleChangeError({
          canManageOwners: input.canManageOwners,
          currentRole: existingGrant?.role ?? null,
          nextRole: input.role,
          ownerId: ownerRows.at(0)?.owner_id ?? null,
          userId: input.userId,
        })
        if (roleChangeError) return yield* Effect.fail(roleChangeError)

        const instanceId =
          input.resourceType === "instance" ? input.resourceId : null
        const databaseId =
          input.resourceType === "database" ? input.resourceId : null
        yield* transaction.execute(
          `UPDATE ${databaseTable("invitation")}
              SET revoked_at = CURRENT_TIMESTAMP(3)
            WHERE email = ? AND relay_id = ?
              AND ((instance_id IS NULL AND ? IS NULL) OR instance_id = ?)
              AND ((database_id IS NULL AND ? IS NULL) OR database_id = ?)
              AND accepted_at IS NULL AND revoked_at IS NULL`,
          [
            input.email,
            input.relayId,
            instanceId,
            instanceId,
            databaseId,
            databaseId,
          ]
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("access_grant")}
             (id, user_id, relay_id, resource_type, resource_id, role, granted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
          [
            input.grantId,
            input.userId,
            input.relayId,
            input.resourceType,
            input.resourceId,
            input.role,
            input.grantedBy,
          ]
        )
      })
  )
})

export async function listUserGrants(
  userId: string,
  relayId?: string
): Promise<Array<AccessGrant>> {
  return runAppEffect(
    "access.listUserGrants",
    listUserGrantsEffect(userId, relayId)
  )
}

export const listUserGrantsEffect = Effect.fn("access.listUserGrants")(
  function* (userId: string, relayId?: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<GrantRow>(
      "access_grants",
      `SELECT id, relay_id, resource_type, resource_id, role
         FROM ${databaseTable("access_grant")}
        WHERE user_id = ?${relayId ? " AND relay_id = ?" : ""}
        ORDER BY created_at ASC`,
      relayId ? [userId, relayId] : [userId]
    )
    return rows.flatMap((row) =>
      isAccessRole(row.role)
        ? [
            {
              id: row.id,
              relayId: row.relay_id,
              resourceId: row.resource_id,
              resourceType: row.resource_type,
              role: row.role,
            },
          ]
        : []
    )
  }
)

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
    user.isDevelopmentBypass || platformRoleHasPermission(user.role, permission)
  )
}

export async function hasRelayPermission(input: {
  user: AuthenticatedUser
  relayId: string
  permission: AccessPermission
  databaseId?: string
  instanceId?: string
}): Promise<boolean> {
  if (isPlatformAdmin(input.user)) return true
  const grants = await listUserGrants(input.user.id, input.relayId)
  return grants.some((grant) => {
    if (!roleHasPermission(grant.role, input.permission)) return false
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
  if (isPlatformAdmin(input.user)) return
  const grants = yield* listUserGrantsEffect(input.user.id, input.relayId)
  const allowed = input.permissions.every((permission) =>
    grants.some((grant) => {
      if (!roleHasPermission(grant.role, permission)) return false
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
    if (isPlatformAdmin(user)) return new Set(instanceIds)
    const grants = yield* listUserGrantsEffect(user.id, relayId)
    if (
      grants.some(
        (grant) =>
          grant.resourceType === "relay" &&
          roleHasPermission(grant.role, "instance.read")
      )
    ) {
      return new Set(instanceIds)
    }
    const allowedInstanceIds = new Set<string>()
    for (const grant of grants) {
      if (
        grant.resourceType === "instance" &&
        roleHasPermission(grant.role, "instance.read")
      ) {
        allowedInstanceIds.add(grant.resourceId)
      }
    }
    return allowedInstanceIds
  }
)

export const deleteInstanceAccessEffect = Effect.fn("access.deleteInstance")(
  function* (relayId: string, instanceId: string) {
    const database = yield* Database
    yield* database.transaction("access.deleteInstance", (transaction) =>
      Effect.gen(function* () {
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
      })
    )
  }
)
