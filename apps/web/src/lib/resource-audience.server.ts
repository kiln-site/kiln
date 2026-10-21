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

/**
 * Everyone enabled who holds `permission` in `scope`: admins, and anyone
 * whose grants or Relay ownership give it to them, the people a
 * notification about an instance goes to. Creating an instance gives no
 * access of its own.
 */
export const resourceAudienceEffect = Effect.fn("resources.audience")(
  function* (scope: ResourceScope, permission: AccessPermission) {
    const database = yield* Database
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
             UNION
             SELECT created_by AS user_id FROM ${databaseTable("relay")}
              WHERE id = ? AND created_by IS NOT NULL
           ) candidate
           JOIN ${databaseTable("user")} account
             ON account.id = candidate.user_id AND account.status = 'enabled'`,
        [scope.relayId, scope.resourceType, scope.resourceId, scope.relayId]
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
