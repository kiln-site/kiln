import { Effect, Option, Schedule } from "effect"
import {
  relayManagedDatabaseSchema,
  relayResourceLimitsV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import {
  forgetNotificationsEffect,
  notifyUsersEffect,
  publishNotificationChange,
  refreshDiskLimitUsageEffect,
  sourceKeysEffect,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect } from "@/effect/runtime"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import { notificationAudienceEffect } from "@/lib/resource-audience.server"
import type { ResourceScope } from "@/lib/resource-permissions"

// Databases keep running past their disk limit. Hearth checks every Relay's
// databases against their limits and tells everyone who can see one that
// has outgrown its limit, once each time it outgrows it. The warning follows
// its usage, and goes away once the data fits again.

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
    const listed = yield* promiseEffect(() =>
      relayRpc(relay, "database.list", {}, 30_000)
    ).pipe(
      Effect.map((value) =>
        Option.some(z.array(relayManagedDatabaseSchema).parse(value))
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Could not list ${relay.name}'s databases to check their disk limits`,
          cause
        ).pipe(Effect.as(Option.none()))
      )
    )
    // Not knowing what fits now, leave its warnings as they are.
    if (Option.isNone(listed)) continue
    const changed = new Set<string>()
    const unsettled = new Set<string>()
    for (const database of listed.value) {
      const { diskBytes } = database.limits
      if (diskBytes === null) continue
      const sourceKey = `${diskLimitKeyPrefix(relay.id)}${database.id}:${diskBytes}`
      // A Relay that just started hasn't measured yet, which says nothing
      // about whether it still doesn't fit.
      if (database.diskUsedBytes === null) {
        unsettled.add(sourceKey)
        continue
      }
      if (database.diskUsedBytes <= diskBytes) continue
      unsettled.add(sourceKey)
      const scope: ResourceScope = {
        relayId: relay.id,
        resourceId: database.id,
        resourceType: "database",
      }
      const recipients = yield* databaseAudienceEffect(scope)
      const delivered = yield* notifyUsersEffect(recipients, sourceKey, {
        kind: "resource.disk-limit",
        limitBytes: diskBytes,
        resource: {
          id: database.id,
          name: database.name,
          relayId: relay.id,
          type: "database",
        },
        usedBytes: database.diskUsedBytes,
      })
      if (delivered > 0) for (const userId of recipients) changed.add(userId)
      const refreshed = yield* refreshDiskLimitUsageEffect(
        sourceKey,
        database.diskUsedBytes
      )
      for (const userId of refreshed) changed.add(userId)
    }
    // What fits now, whose limit changed, or that's gone. Forgetting these
    // lets the next time it outgrows a limit warn again.
    const told = yield* sourceKeysEffect(
      "resource.disk-limit",
      diskLimitKeyPrefix(relay.id)
    )
    const settled = yield* forgetNotificationsEffect(
      "resource.disk-limit",
      told.filter((key) => !unsettled.has(key))
    )
    for (const userId of settled) changed.add(userId)
    publishNotificationChange([...changed])
  }
})

function diskLimitKeyPrefix(relayId: string) {
  return `resource.disk-limit:database:${relayId}:`
}

const databaseAudienceEffect = (scope: ResourceScope) =>
  notificationAudienceEffect(scope, "database.read", "resource.disk-limit")
