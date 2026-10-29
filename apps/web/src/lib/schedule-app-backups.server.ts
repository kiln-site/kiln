import {
  scheduleActionAppliesToTarget,
  scheduleTargetKey,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"
import { Effect, Result } from "effect"

import { promiseEffect } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelays } from "@/lib/relay-registry"
import { appTargets, readRelayVolumes } from "@/server/app-backups.server"
import { requireAppsPermission } from "@/server/backup-target-access.server"

/**
 * Refuses a schedule whose stopped App backup the person couldn't start by
 * hand: it stops and starts the App and every App that uses a volume it
 * owns, so it takes `app.manage` on each, as a manual one does. Which Apps
 * those are is the Relay's to say; while it can't, only a stopped backup
 * the schedule already had of that App is kept.
 */
export async function requireScheduleAppBackups(input: {
  readonly actions: ReadonlyArray<ScheduleAction>
  readonly existing?: { readonly actions: ReadonlyArray<ScheduleAction> }
  readonly targets: ReadonlyArray<ScheduleTarget>
  readonly user: AuthenticatedUser
}): Promise<void> {
  const stopped = stoppedAppBackups(input.actions, input.targets)
  if (stopped.length === 0) return
  const saved = new Set(
    input.existing
      ? stoppedAppBackups(input.existing.actions, input.targets).map(
          scheduleTargetKey
        )
      : []
  )
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  for (const target of stopped) {
    const relay = relays.get(target.relayId)
    const listed = relay?.enabled
      ? await Effect.runPromise(
          Effect.result(
            promiseEffect(() => readRelayVolumes(relay, input.user.id))
          )
        )
      : null
    const listing = listed && Result.isSuccess(listed) ? listed.success : null
    if (!listing?.protection.ready) {
      if (saved.has(scheduleTargetKey(target))) continue
      throw new Error(
        `${target.name}'s Relay must be online and know which Apps use its volumes before it can be backed up stopped`
      )
    }
    const owned = new Set(
      appTargets(target.id, listing).map((member) => member.id)
    )
    const users = new Set([target.id])
    for (const volume of listing.volumes) {
      if (volume.id === null || !owned.has(volume.id)) continue
      for (const user of volume.users) users.add(user.appId)
    }
    await requireAppsPermission(
      input.user,
      target.relayId,
      [...users],
      "app.manage",
      `A stopped backup of ${target.name} stops and starts every App that uses what it backs up; you need permission to manage each`
    )
  }
}

// The App targets a stopped backup step runs on.
function stoppedAppBackups(
  actions: ReadonlyArray<ScheduleAction>,
  targets: ReadonlyArray<ScheduleTarget>
): Array<ScheduleTarget> {
  const found = new Map<string, ScheduleTarget>()
  for (const action of actions) {
    if (action.type !== "backup" || action.consistency !== "stopped") continue
    for (const target of targets) {
      if (target.kind === "app" && scheduleActionAppliesToTarget(action, target))
        found.set(scheduleTargetKey(target), target)
    }
  }
  return [...found.values()]
}
