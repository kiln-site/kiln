import type { PermissionScopeType } from "@workspace/contracts"

import { databaseTable } from "@/lib/database-config"

/**
 * Where each kind of resource records its owner. Relays are owned by the
 * person who paired them; game servers, databases and apps by `owner_id`.
 */
const ownerColumns: Record<
  PermissionScopeType,
  { idColumn: string; ownerColumn: string; table: string }
> = {
  app: { idColumn: "app_id", ownerColumn: "owner_id", table: "app" },
  database: {
    idColumn: "database_id",
    ownerColumn: "owner_id",
    table: "database",
  },
  instance: {
    idColumn: "instance_id",
    ownerColumn: "owner_id",
    table: "instance",
  },
  relay: { idColumn: "id", ownerColumn: "created_by", table: "relay" },
}

/** A query for one resource's owner id, as `user_id`. */
export function resourceOwnerQuery(scope: {
  relayId: string
  resourceId: string
  resourceType: PermissionScopeType
}): { sql: string; values: Array<string> } {
  const { idColumn, ownerColumn, table } = ownerColumns[scope.resourceType]
  return scope.resourceType === "relay"
    ? {
        sql: `SELECT ${ownerColumn} AS user_id FROM ${databaseTable(table)} WHERE ${idColumn} = ?`,
        values: [scope.relayId],
      }
    : {
        sql: `SELECT ${ownerColumn} AS user_id FROM ${databaseTable(table)} WHERE relay_id = ? AND ${idColumn} = ?`,
        values: [scope.relayId, scope.resourceId],
      }
}
