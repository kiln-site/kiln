import type { RowDataPacket } from "mysql2/promise"
import type { AccessPermission } from "@workspace/contracts"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { platformAdminIdsEffect } from "@/effect/notifications"
import { databaseTable } from "@/lib/database-config"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
} from "@/lib/resource-permissions"
import { resourceOwnerQuery } from "@/lib/resource-owners"

/**
 * Everyone enabled who holds `permission` in `scope`: admins, and anyone
 * whose grants or ownership of the resource or its Relay give it to them,
 * the people a notification about an instance goes to.
 */
export const resourceAudienceEffect = Effect.fn("resources.audience")(
  function* (scope: ResourceScope, permission: AccessPermission) {
    const database = yield* Database
    const relayOwner = resourceOwnerQuery({
      relayId: scope.relayId,
      resourceId: scope.relayId,
      resourceType: "relay",
    })
    const owner =
      scope.resourceType === "relay" ? null : resourceOwnerQuery(scope)
    const [admins, candidates] = yield* Effect.all([
      platformAdminIdsEffect(),
      database.queryRows<RowDataPacket & { user_id: string }>(
        "resources.audience.candidates",
        `SELECT candidate.user_id
           FROM (
             SELECT user_id FROM ${databaseTable("access_grant")}
              WHERE state = 'active' AND relay_id = ?
                AND (resource_type = 'relay'
                  OR (resource_type = ? AND resource_id = ?))
             UNION ${relayOwner.sql}${owner ? `
             UNION ${owner.sql}` : ""}
           ) candidate
           JOIN ${databaseTable("user")} account
             ON account.id = candidate.user_id AND account.status = 'enabled'`,
        [
          scope.relayId,
          scope.resourceType,
          scope.resourceId,
          ...relayOwner.values,
          ...(owner?.values ?? []),
        ]
      ),
    ])
    const adminIds = new Set(admins)
    const holders = yield* Effect.forEach(
      candidates.filter((row) => !adminIds.has(row.user_id)),
      (row) =>
        loadResourceGrantsEffect(
          row.user_id,
          scope.relayId,
          undefined,
          scope
        ).pipe(
          Effect.map((grants) =>
            effectiveScopePermissions(grants, scope).has(permission)
              ? [row.user_id]
              : []
          )
        ),
      { concurrency: 4 }
    )
    return [...adminIds, ...holders.flat()]
  }
)
