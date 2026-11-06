import type { RowDataPacket } from "mysql2/promise"
import type { AccessPermission } from "@workspace/contracts"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { loadNotificationPreferencesEffect } from "@/effect/notification-preferences"
import { platformAdminIdsEffect } from "@/effect/notifications"
import { databaseTable } from "@/lib/database-config"
import {
  notificationResourceKey,
  type NotificationKind,
} from "@/lib/notifications"
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
             UNION ${relayOwner.sql}${
               owner
                 ? `
             UNION ${owner.sql}`
                 : ""
             }
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

/**
 * Those of `resourceAudienceEffect` who want this kind of notification about
 * this resource: they didn't turn it off for the resource, and it's of the
 * instances they asked to hear about. Leaving someone out rather than clearing
 * theirs means turning it back on hears of whatever's still announced.
 */
export const notificationAudienceEffect = (
  scope: ResourceScope,
  permission: AccessPermission,
  kind: NotificationKind
) =>
  notificationAudiencesEffect(scope, permission, kind).pipe(
    Effect.map(({ wanted }) => wanted)
  )

/**
 * Both `audience`, who can act on the resource, and `wanted`, those of them
 * who want this notification, for an event that also settles what those left
 * out already have.
 */
export const notificationAudiencesEffect = Effect.fn(
  "resources.notificationAudience"
)(function* (
  scope: ResourceScope,
  permission: AccessPermission,
  kind: NotificationKind
) {
  const audience = yield* resourceAudienceEffect(scope, permission)
  const preferences = yield* loadNotificationPreferencesEffect(audience)
  const key = notificationResourceKey({
    id: scope.resourceId,
    relayId: scope.relayId,
    type: scope.resourceType,
  })
  const unmuted = audience.filter(
    (userId) => preferences.get(userId)?.resources[key]?.kinds[kind] !== false
  )
  const scopeOf = (userId: string) => preferences.get(userId)?.scope ?? "all"
  if (unmuted.every((userId) => scopeOf(userId) === "all"))
    return { audience, wanted: unmuted }
  const { owners, shared } = yield* resourceRelationsEffect(scope)
  const wanted = unmuted.filter((userId) => {
    switch (scopeOf(userId)) {
      case "all":
        return true
      case "shared":
        return owners.has(userId) || shared.has(userId)
      case "own":
        return owners.has(userId)
    }
  })
  return { audience, wanted }
})

// Who owns the resource, and who it reaches through a grant or their Relay,
// which is everyone with a claim to it besides a platform role.
const resourceRelationsEffect = Effect.fnUntraced(function* (
  scope: ResourceScope
) {
  const database = yield* Database
  const owner = resourceOwnerQuery(scope)
  const relayOwner = resourceOwnerQuery({
    relayId: scope.relayId,
    resourceId: scope.relayId,
    resourceType: "relay",
  })
  const [owners, shared] = yield* Effect.all([
    database.queryRows<RowDataPacket & { user_id: string | null }>(
      "resources.relations.owner",
      owner.sql,
      owner.values
    ),
    database.queryRows<RowDataPacket & { user_id: string | null }>(
      "resources.relations.shared",
      `SELECT user_id FROM ${databaseTable("access_grant")}
        WHERE state = 'active' AND relay_id = ?
          AND (resource_type = 'relay'
            OR (resource_type = ? AND resource_id = ?))
        UNION ${relayOwner.sql}`,
      [
        scope.relayId,
        scope.resourceType,
        scope.resourceId,
        ...relayOwner.values,
      ]
    ),
  ])
  const ids = (rows: ReadonlyArray<{ user_id: string | null }>) =>
    new Set(rows.flatMap((row) => (row.user_id ? [row.user_id] : [])))
  return { owners: ids(owners), shared: ids(shared) }
})
