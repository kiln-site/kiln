import type { RowDataPacket } from "mysql2/promise"
import {
  accessPermissionSupported,
  builtinPermissionPresets,
  builtinPresetSelections,
  expandPermissionSelections,
  permissionCatalog,
  permissionCollections,
  type PermissionSelection,
} from "@workspace/contracts"

import { ownerDisplayName } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { databasePool } from "@/lib/database"
import { resourceOwnerQuery } from "@/lib/resource-owners"
import type { AccessPermission } from "@/lib/permissions"
import {
  databaseScopeCapabilities,
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type AccessGrantScope,
} from "@/lib/resource-permissions"

// Who the Access page lists for a scope. The server functions in
// ./resource-access authenticate, then hand the user here.

const inheritedPeopleSelectors = new Map(
  (["instance", "database"] as const).map((scope) => {
    const grantsRead = (selection: PermissionSelection) =>
      expandPermissionSelections([selection], "relay").includes(`${scope}.read`)
    return [
      scope,
      {
        permissions: permissionCatalog.flatMap((entry) =>
          accessPermissionSupported(entry.key, "relay") &&
          grantsRead({ kind: "permission", key: entry.key })
            ? [entry.key]
            : []
        ),
        collections: permissionCollections.flatMap((entry) =>
          entry.scopeTypes.includes("relay") &&
          grantsRead({ kind: "collection", key: entry.key })
            ? [entry.key]
            : []
        ),
        builtins: builtinPermissionPresets.flatMap((entry) =>
          expandPermissionSelections(
            builtinPresetSelections(entry.key, "relay"),
            "relay"
          ).includes(`${scope}.read`)
            ? [entry.key]
            : []
        ),
      },
    ] as const
  })
)

// The grants the Access page lists for a scope: invited and accepted people
// on it and, below a Relay, those whose Relay access lets them read it.
export function peopleFilter(scope: AccessGrantScope): {
  sql: string
  values: Array<unknown>
} {
  const inheritedSelectors =
    scope.resourceType === "relay"
      ? undefined
      : inheritedPeopleSelectors.get(scope.resourceType)
  const readSelection = (alias: string) =>
    `((${alias}.selection_kind = 'permission' AND ${alias}.selection_key IN (?)) OR (${alias}.selection_kind = 'collection' AND ${alias}.selection_key IN (?)))`
  const inheritedFilter = inheritedSelectors
    ? ` OR (g.resource_type = 'relay' AND g.resource_id = g.relay_id AND g.state = 'active' AND (
        EXISTS (SELECT 1 FROM ${databaseTable("access_selection")} s WHERE s.access_id = g.id AND ${readSelection("s")})
        OR EXISTS (SELECT 1 FROM ${databaseTable("access_preset")} a
          JOIN ${databaseTable("permission_preset")} p ON p.id = a.preset_id AND p.relay_id = g.relay_id AND p.resource_type = g.resource_type AND p.resource_id = g.resource_id
          JOIN ${databaseTable("preset_selection")} s ON s.preset_id = p.id
          WHERE a.access_id = g.id AND ${readSelection("s")})
        OR EXISTS (SELECT 1 FROM ${databaseTable("access_preset")} a WHERE a.access_id = g.id AND a.builtin_key IN (?))
      ))`
    : ""
  return {
    sql: `g.relay_id = ? AND ((g.resource_type = ? AND g.resource_id = ?)${inheritedFilter}) AND g.state <> 'revoked'`,
    values: [
      scope.relayId,
      scope.resourceType,
      scope.resourceId,
      ...(inheritedSelectors
        ? [
            inheritedSelectors.permissions,
            inheritedSelectors.collections,
            inheritedSelectors.permissions,
            inheritedSelectors.collections,
            inheritedSelectors.builtins,
          ]
        : []),
    ],
  }
}

// How many people the Access page lists for a scope, with its owner: those
// invited or with access, not platform admins who only see it as admins.
// Null for those who can't read its people.
export async function getResourceUserCountHandler(
  user: AuthenticatedUser,
  data: AccessGrantScope
): Promise<number | null> {
  if (data.resourceType === "relay" && data.resourceId !== data.relayId)
    throw new Error("Resource not found")
  const admin = user.role === "admin" || user.isDevelopmentBypass
  if (!admin) {
    const grants = await runAppEffect(
      "access.scope",
      loadResourceGrantsEffect(user.id, data.relayId, undefined, data)
    )
    if (!effectiveScopePermissions(grants, data).has("access.read")) {
      return null
    }
  }
  const people = peopleFilter(data)
  const owner = resourceOwnerQuery(data)
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { count: number | string }>
  >(
    `SELECT COUNT(*) AS count FROM (
       SELECT g.user_id FROM ${databaseTable("access_grant")} g
         JOIN ${databaseTable("user")} u ON u.id = g.user_id
        WHERE ${people.sql}
       UNION
       SELECT owner.user_id FROM (${owner.sql}) owner
         JOIN ${databaseTable("user")} u ON u.id = owner.user_id
     ) people`,
    [...people.values, ...owner.values]
  )
  return Number(rows[0]?.count ?? 0)
}

interface ResourceOwnerRow extends RowDataPacket {
  email: string
  id: string
  name: string | null
}

// The permissions a viewer holds on a scope that apply to it, as the Access
// page reads them: Relay access that doesn't reach this kind of resource,
// or this database's engine, doesn't count.
export async function supportedScopePermissions(
  data: AccessGrantScope,
  permissions: ReadonlyArray<AccessPermission>
): Promise<{
  permissions: Array<AccessPermission>
  supportedCapabilities: Array<string> | undefined
}> {
  const [engines] =
    data.resourceType === "database"
      ? await databasePool.query<Array<RowDataPacket & { engine: string }>>(
          `SELECT engine FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ?`,
          [data.relayId, data.resourceId]
        )
      : [[]]
  const supportedCapabilities =
    data.resourceType === "database"
      ? databaseScopeCapabilities(engines[0]?.engine)
      : undefined
  return {
    permissions: permissions.filter((permission) =>
      accessPermissionSupported(
        permission,
        data.resourceType,
        supportedCapabilities
      )
    ),
    supportedCapabilities,
  }
}

// A scope's owner, for those the Access page would show the scope to. Like
// it, only those who can read its people see the owner's email.
async function readableResourceOwner(
  user: AuthenticatedUser,
  data: AccessGrantScope
): Promise<{ canReadPeople: boolean; row: ResourceOwnerRow } | null> {
  if (data.resourceType === "relay" && data.resourceId !== data.relayId)
    throw new Error("Resource not found")
  const admin = user.role === "admin" || user.isDevelopmentBypass
  const permissions = admin
    ? expandPermissionSelections(
        [{ kind: "collection", key: "all" }],
        data.resourceType
      )
    : [
        ...effectiveScopePermissions(
          await runAppEffect(
            "access.scope",
            loadResourceGrantsEffect(user.id, data.relayId, undefined, data)
          ),
          data
        ),
      ]
  const supported = await supportedScopePermissions(data, permissions)
  if (!supported.permissions.length) throw new Error("Resource not found")
  const owner = resourceOwnerQuery(data)
  const [rows] = await databasePool.query<Array<ResourceOwnerRow>>(
    `SELECT u.id, u.name, u.email FROM (${owner.sql}) owner
       JOIN ${databaseTable("user")} u ON u.id = owner.user_id`,
    owner.values
  )
  const row = rows[0]
  return row
    ? { canReadPeople: permissions.includes("access.read"), row }
    : null
}

// Who owns a scope, as its Info rail shows them, or null when no one does
// and the platform manages it.
export async function getResourceOwnerHandler(
  user: AuthenticatedUser,
  data: AccessGrantScope
): Promise<{ email: string | null; name: string; userId: string } | null> {
  const owner = await readableResourceOwner(user, data)
  if (!owner) return null
  return {
    email: owner.canReadPeople ? owner.row.email : null,
    name: ownerDisplayName(owner.row, owner.canReadPeople),
    // For their picture.
    userId: owner.row.id,
  }
}
