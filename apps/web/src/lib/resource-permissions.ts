import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import {
  accessPermissionSupported,
  builtinPresetSelections,
  databaseEngineSupportsLogicalBackups,
  expandPermissionSelections,
  type AccessPermission,
  type DatabaseEngine,
  type PermissionScopeType,
  type PermissionSelection,
} from "@workspace/contracts"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface ResourceScope {
  relayId: string
  resourceType: PermissionScopeType
  resourceId: string
}

export interface ResolvedAccessGrant extends ResourceScope {
  id: string
  permissions: Array<AccessPermission>
  source: "access" | "owner"
}

interface GrantRow extends RowDataPacket {
  id: string
  relay_id: string
  resource_type: PermissionScopeType
  resource_id: string
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
      `SELECT g.id, g.relay_id, g.resource_type, g.resource_id, d.engine
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
      permissions: expandResourceGrantPermissions(
        row,
        byAccess.get(row.id) ?? []
      ),
      source: "access",
    }))
    // Ownership is authority in its own right, independent of invitations and
    // presets. Relays are owned by their creator and instances by owner_id.
    // Databases have no owner: their creator acts through Relay-scope grants,
    // as before this model, so revoking Relay access revokes database access.
    const ownerRows = yield* query<GrantRow>(
      `SELECT id, id AS relay_id, 'relay' AS resource_type, id AS resource_id, NULL AS engine
         FROM ${databaseTable("relay")} WHERE created_by = ?${relayId ? " AND id = ?" : ""}
       UNION ALL
       SELECT instance_id AS id, relay_id, 'instance', instance_id, NULL
         FROM ${databaseTable("instance")} WHERE owner_id = ?${relayId ? " AND relay_id = ?" : ""}${scope ? " AND instance_id = ?" : ""}`,
      [
        userId,
        ...(relayId ? [relayId] : []),
        userId,
        ...(relayId ? [relayId] : []),
        ...(scope
          ? [scope.resourceType === "instance" ? scope.resourceId : ""]
          : []),
      ]
    )
    for (const row of ownerRows) {
      grants.push({
        id: `owner:${row.resource_type}:${row.resource_id}`,
        relayId: row.relay_id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
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
      ? databaseScopeCapabilities(row.engine)
      : undefined
  return expandStoredSelections(selections, row.resource_type, capabilities)
}

/**
 * Persisted selections can outlive an engine change or carry migrated legacy
 * keys. Unsupported explicit entries are inactive rather than a load error;
 * only fresh user input should reject unsupported keys.
 */
export function expandStoredSelections(
  selections: ReadonlyArray<PermissionSelection>,
  scopeType: PermissionScopeType,
  capabilities?: ReadonlyArray<string>
): Array<AccessPermission> {
  const supported = deduplicatePermissionSelections(selections).filter(
    (selection) =>
      selection.kind === "collection" ||
      accessPermissionSupported(selection.key, scopeType, capabilities)
  )
  return expandPermissionSelections(supported, scopeType, capabilities)
}

export function effectiveScopePermissions(
  grants: ReadonlyArray<
    Pick<
      ResolvedAccessGrant,
      "relayId" | "resourceType" | "resourceId" | "permissions"
    >
  >,
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

/** Capability tags an engine supports; server-side support checks stay authoritative. */
export function databaseScopeCapabilities(
  engine: string | null | undefined
): Array<string> {
  return databaseEngineSupportsLogicalBackups(engine as DatabaseEngine)
    ? ["database.logical-backups"]
    : []
}
