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

import { runAppEffect } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { databasePool } from "@/lib/database"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
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
export function peopleFilter(scope: ResourceScope): {
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

// Who owns each kind of resource.
function ownerIdQuery(scope: ResourceScope): {
  sql: string
  values: Array<unknown>
} {
  if (scope.resourceType === "relay") {
    return {
      sql: `SELECT created_by AS user_id FROM ${databaseTable("relay")} WHERE id = ?`,
      values: [scope.relayId],
    }
  }
  return scope.resourceType === "instance"
    ? {
        sql: `SELECT owner_id AS user_id FROM ${databaseTable("instance")} WHERE relay_id = ? AND instance_id = ?`,
        values: [scope.relayId, scope.resourceId],
      }
    : {
        sql: `SELECT created_by AS user_id FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ?`,
        values: [scope.relayId, scope.resourceId],
      }
}

// How many people the Access page lists for a scope, with its owner: those
// invited or with access, not platform admins who only see it as admins.
// Null for those who can't read its people.
export async function getResourceUserCountHandler(
  user: AuthenticatedUser,
  data: ResourceScope
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
  const owner = ownerIdQuery(data)
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
