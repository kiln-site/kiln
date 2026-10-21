import { Effect, Schedule } from "effect"
import {
  relayManagedDatabaseSchema,
  relayResourceLimitsV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect } from "@/effect/runtime"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"
import type { ResourceScope } from "@/lib/resource-permissions"

// Databases keep running past their disk limit. Hearth checks every Relay's
// databases against their limits and tells everyone who can see one that
// has outgrown its limit, once for each limit it outgrows.

const CHECK_INTERVAL = "5 minutes"

// Process-wide, so a reloaded module doesn't start a second worker.
const workerState = globalThis as typeof globalThis & {
  __kilnDiskLimitWarningsStarted?: boolean
}

export function startDiskLimitWarnings(): void {
  if (workerState.__kilnDiskLimitWarningsStarted) return
  workerState.__kilnDiskLimitWarningsStarted = true
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

const databaseAudienceEffect = (scope: ResourceScope) =>
  resourceAudienceEffect(scope, "database.read")
