import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import {
  accessPermissionSupported,
  builtinPresetSelections,
  expandPermissionSelections,
  type AccessPermission,
  type PermissionScopeType,
  type PermissionSelection,
} from "@workspace/contracts"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import type { AccessRole } from "@/lib/permissions"

export interface ResourceScope {
  relayId: string
  resourceType: PermissionScopeType
  resourceId: string
}

export interface ResolvedAccessGrant extends ResourceScope {
  id: string
  role: AccessRole
  permissions: Array<AccessPermission>
  source: "access" | "owner"
}

interface GrantRow extends RowDataPacket {
  id: string
  relay_id: string
  resource_type: PermissionScopeType
  resource_id: string
  role: string
  engine: string | null
}

interface SelectionRow extends RowDataPacket {
  access_id: string
  selection_kind: "permission" | "collection" | "builtin"
  selection_key: string
}

/** Load live selections in batches; never turn an empty selection into a role. */
export const loadResourceGrantsEffect = Effect.fn("access.resolveGrants")(
  function* (
    userId: string,
    relayId?: string,
    transaction?: DatabaseTransaction,
    scope?: ResourceScope
  ) {
    const database = yield* Database
    const query =
      transaction?.queryRows ??
      (<T extends RowDataPacket>(sql: string, values?: Array<string>) =>
        database.queryRows<T>("access.resolveGrants", sql, values))
    const values = [
      userId,
      ...(relayId ? [relayId] : []),
      ...(scope && scope.resourceType !== "relay"
        ? [scope.resourceType, scope.resourceId]
        : []),
    ]
    const filter = `g.user_id = ? AND g.state = 'active'${relayId ? " AND g.relay_id = ?" : ""}${scope ? (scope.resourceType === "relay" ? " AND g.resource_type = 'relay'" : " AND (g.resource_type = 'relay' OR (g.resource_type = ? AND g.resource_id = ?))") : ""}`
    const rows = yield* query<GrantRow>(
      `SELECT g.id, g.relay_id, g.resource_type, g.resource_id, g.role, d.engine
         FROM ${databaseTable("access_grant")} g
         LEFT JOIN ${databaseTable("database")} d ON g.resource_type = 'database' AND d.relay_id = g.relay_id AND d.database_id = g.resource_id
         WHERE ${filter}`,
      values
    )
    const selections =
      rows.length === 0
        ? []
        : yield* query<SelectionRow>(
            `SELECT s.access_id, s.selection_kind, s.selection_key
         FROM ${databaseTable("access_grant")} g
         JOIN ${databaseTable("access_selection")} s ON s.access_id = g.id
        WHERE ${filter}
       UNION ALL
       SELECT a.access_id, s.selection_kind, s.selection_key
         FROM ${databaseTable("access_grant")} g
         JOIN ${databaseTable("access_preset")} a ON a.access_id = g.id
         JOIN ${databaseTable("permission_preset")} p ON p.id = a.preset_id
          AND p.relay_id = g.relay_id AND p.resource_type = g.resource_type AND p.resource_id = g.resource_id
         JOIN ${databaseTable("preset_selection")} s ON s.preset_id = p.id
        WHERE ${filter}
       UNION ALL
       SELECT a.access_id, 'builtin', a.builtin_key
         FROM ${databaseTable("access_grant")} g
         JOIN ${databaseTable("access_preset")} a ON a.access_id = g.id
        WHERE ${filter} AND a.builtin_key IS NOT NULL`,
            [...values, ...values, ...values]
          )
    const grantsById = new Map(rows.map((row) => [row.id, row]))
    const byAccess = new Map<string, Array<PermissionSelection>>()
    for (const row of selections) {
      const selected = byAccess.get(row.access_id) ?? []
      if (row.selection_kind === "builtin") {
        const grant = grantsById.get(row.access_id)
        if (grant)
          selected.push(
            ...builtinPresetSelections(row.selection_key, grant.resource_type)
          )
      } else {
        selected.push({ kind: row.selection_kind, key: row.selection_key })
      }
      byAccess.set(row.access_id, selected)
    }
    const grants: Array<ResolvedAccessGrant> = rows.map((row) => ({
      id: row.id,
      relayId: row.relay_id,
      resourceId: row.resource_id,
      resourceType: row.resource_type,
      role: "viewer",
      permissions: expandResourceGrantPermissions(
        row,
        byAccess.get(row.id) ?? []
      ),
      source: "access",
    }))
    // Ownership is authority in its own right, independent of invitations and presets.
    const ownerRows = yield* query<GrantRow>(
      `SELECT id, id AS relay_id, 'relay' AS resource_type, id AS resource_id, 'owner' AS role, NULL AS engine
         FROM ${databaseTable("relay")} WHERE created_by = ?${relayId ? " AND id = ?" : ""}
       UNION ALL
       SELECT instance_id AS id, relay_id, 'instance', instance_id, 'owner', NULL
         FROM ${databaseTable("instance")} WHERE owner_id = ?${relayId ? " AND relay_id = ?" : ""}${scope ? " AND instance_id = ?" : ""}
       UNION ALL
       SELECT database_id AS id, relay_id, 'database', database_id, 'owner', engine
         FROM ${databaseTable("database")} WHERE created_by = ?${relayId ? " AND relay_id = ?" : ""}${scope ? " AND database_id = ?" : ""}`,
      [
        userId,
        ...(relayId ? [relayId] : []),
        userId,
        ...(relayId ? [relayId] : []),
        ...(scope
          ? [scope.resourceType === "instance" ? scope.resourceId : ""]
          : []),
        userId,
        ...(relayId ? [relayId] : []),
        ...(scope
          ? [scope.resourceType === "database" ? scope.resourceId : ""]
          : []),
      ]
    )
    for (const row of ownerRows) {
      grants.push({
        id: `owner:${row.resource_type}:${row.resource_id}`,
        relayId: row.relay_id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
        role: "owner",
        permissions: expandResourceGrantPermissions(row, [
          { kind: "collection", key: "all" },
        ]),
        source: "owner",
      })
    }
    return grants
  }
)

function expandResourceGrantPermissions(
  row: Pick<GrantRow, "resource_type" | "engine">,
  selections: ReadonlyArray<PermissionSelection>
): Array<AccessPermission> {
  const capabilities =
    row.resource_type === "database"
      ? ["mysql", "mariadb", "postgres"].includes(row.engine ?? "")
        ? ["database.logical-backups"]
        : []
      : undefined
  // Persisted assignments can outlive an engine change or contain migrated
  // legacy bits. Unsupported explicit entries are inactive, not a load error.
  const supported = deduplicatePermissionSelections(selections).filter(
    (selection) =>
      selection.kind === "collection" ||
      accessPermissionSupported(selection.key, row.resource_type, capabilities)
  )
  return expandPermissionSelections(supported, row.resource_type, capabilities)
}

export function effectiveScopePermissions(
  grants: ReadonlyArray<ResolvedAccessGrant>,
  scope: ResourceScope
): Set<AccessPermission> {
  const permissions = new Set<AccessPermission>()
  for (const grant of grants) {
    if (
      grant.relayId === scope.relayId &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === scope.resourceType &&
          grant.resourceId === scope.resourceId))
    ) {
      for (const permission of grant.permissions) permissions.add(permission)
    }
  }
  return permissions
}

export function deduplicatePermissionSelections(
  selections: ReadonlyArray<PermissionSelection>
): Array<PermissionSelection> {
  return [
    ...new Map(
      selections.map((selection) => [
        `${selection.kind}:${selection.key}`,
        selection,
      ])
    ).values(),
  ]
}
