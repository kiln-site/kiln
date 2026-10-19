import type { RowDataPacket } from "mysql2/promise"
import { Effect, Schedule } from "effect"
import {
  relayManagedDatabaseSchema,
  relayResourceLimitsV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import { Database } from "@/effect/database"
import {
  notifyUsersEffect,
  platformAdminIdsEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
} from "@/lib/resource-permissions"

// Databases keep running past their disk limit. Hearth checks every
// Relay's databases against theirs and tells everyone who can see one that
// has outgrown its limit, once for each limit it outgrows.

const CHECK_INTERVAL = "5 minutes"

let started = false

export function startDiskLimitWarnings(): void {
  if (started) return
  started = true
  forkAppEffect(
    "diskLimits.warnings",
    warnDatabasesOverDiskLimitEffect().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check database disk limits", cause)
      ),
      Effect.repeat(Schedule.spaced(CHECK_INTERVAL))
    )
  )
}

export const warnDatabasesOverDiskLimitEffect = Effect.fn(
  "diskLimits.warnDatabases"
)(function* () {
  const relays = (yield* listPersistedRelaysEffect()).filter(
    (relay) =>
      relay.enabled &&
      relayConnectionFeatures(relay.id).has(relayResourceLimitsV1Feature)
  )
  for (const relay of relays) {
    const databases = yield* promiseEffect(() =>
      relayRpc(relay, "database.list", {}, 30_000)
    ).pipe(
      Effect.map((value) => z.array(relayManagedDatabaseSchema).parse(value)),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Could not list ${relay.name}'s databases to check their disk limits`,
          cause
        ).pipe(Effect.as([]))
      )
    )
    for (const database of databases) {
      const { diskBytes } = database.limits
      if (
        diskBytes === null ||
        database.diskUsedBytes === null ||
        database.diskUsedBytes <= diskBytes
      ) {
        continue
      }
      const scope: ResourceScope = {
        relayId: relay.id,
        resourceId: database.id,
        resourceType: "database",
      }
      const recipients = yield* databaseAudienceEffect(scope)
      const delivered = yield* notifyUsersEffect(
        recipients,
        `resource.disk-limit:database:${relay.id}:${database.id}:${diskBytes}`,
        {
          kind: "resource.disk-limit",
          limitBytes: diskBytes,
          resource: {
            id: database.id,
            name: database.name,
            relayId: relay.id,
            type: "database",
          },
          usedBytes: database.diskUsedBytes,
        }
      )
      if (delivered > 0) publishNotificationChange(recipients)
    }
  }
})

/** Everyone who can see the database: admins, its owner, and grantees. */
const databaseAudienceEffect = Effect.fn("diskLimits.databaseAudience")(
  function* (scope: ResourceScope) {
    const database = yield* Database
    const [admins, owners, grantees] = yield* Effect.all([
      platformAdminIdsEffect(),
      database.queryRows<RowDataPacket & { user_id: string }>(
        "diskLimits.databaseOwner",
        `SELECT created_by AS user_id FROM ${databaseTable("database")}
          WHERE relay_id = ? AND database_id = ? AND created_by IS NOT NULL`,
        [scope.relayId, scope.resourceId]
      ),
      database.queryRows<RowDataPacket & { user_id: string }>(
        "diskLimits.databaseGrantees",
        `SELECT DISTINCT user_id FROM ${databaseTable("access_grant")}
          WHERE state = 'active' AND relay_id = ?
            AND (resource_type = 'relay'
              OR (resource_type = 'database' AND resource_id = ?))`,
        [scope.relayId, scope.resourceId]
      ),
    ])
    const known = new Set([...admins, ...owners.map((row) => row.user_id)])
    // A Relay-wide grant doesn't always reach databases, so each grantee's
    // permissions are resolved as they'd be to open it.
    const readers = yield* Effect.forEach(
      grantees.filter((row) => !known.has(row.user_id)),
      (row) =>
        loadResourceGrantsEffect(
          row.user_id,
          scope.relayId,
          undefined,
          scope
        ).pipe(
          Effect.map((grants) =>
            effectiveScopePermissions(grants, scope).has("database.read")
              ? [row.user_id]
              : []
          )
        ),
      { concurrency: 4 }
    )
    return [...known, ...readers.flat()]
  }
)
