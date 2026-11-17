import {
  scheduleActionAppliesToTarget,
  scheduleTargetKey,
  type ScheduleAction,
  type ScheduleTarget,
} from "@workspace/contracts/schedules"
import type { RelayVolumes } from "@workspace/contracts"

import { recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelays } from "@/lib/relay-registry"
import { appTargets, readRelayVolumes } from "@/server/app-backups.server"
import { requireAppsPermission } from "@/server/backup-target-access.server"

/**
 * Refuses a schedule whose stopped backup of an App or a volume the person
 * couldn't start by hand: it stops and starts every App that uses what it
 * backs up (for an App, itself and every App that uses a volume it uses),
 * so it takes `instance.power.stop` on each, as a manual one does. Which
 * Apps those are is the Relay's to say; while it can't, only a stopped
 * backup the schedule already had of that target is kept.
 */
export async function requireScheduleAppBackups(input: {
  readonly actions: ReadonlyArray<ScheduleAction>
  readonly existing?: { readonly actions: ReadonlyArray<ScheduleAction> }
  readonly targets: ReadonlyArray<ScheduleTarget>
  readonly user: AuthenticatedUser
}): Promise<void> {
  const stopped = stoppedBackups(input.actions, input.targets)
  if (stopped.length === 0) return
  const saved = new Set(
    input.existing
      ? stoppedBackups(input.existing.actions, input.targets).map(
          scheduleTargetKey
        )
      : []
  )
  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  // Asked once for each Relay, however many of its targets stop.
  const listings = new Map<string, Promise<RelayVolumes | null>>()
  const listingOf = (relayId: string) => {
    const known = listings.get(relayId)
    if (known) return known
    const relay = relays.get(relayId)
    const asked = relay?.enabled
      ? recoverPromise(
          () => readRelayVolumes(relay, input.user.id),
          () => null
        )
      : Promise.resolve(null)
    listings.set(relayId, asked)
    return asked
  }
  for (const target of stopped) {
    const listing = await listingOf(target.relayId)
    if (!listing?.protection.ready) {
      if (saved.has(scheduleTargetKey(target))) continue
      throw new Error(
        `${target.name}'s Relay must be online and know which Apps use its volumes before it can be backed up stopped`
      )
    }
    const owned = new Set(
      target.kind === "app"
        ? appTargets(target.id, listing).map((member) => member.id)
        : [target.id]
    )
    const users = new Set(target.kind === "app" ? [target.id] : [])
    for (const volume of listing.volumes) {
      if (volume.id === null || !owned.has(volume.id)) continue
      for (const user of volume.users) users.add(user.appId)
    }
    await requireAppsPermission(
      input.user,
      target.relayId,
      [...users],
      "instance.power.stop",
      `A stopped backup of ${target.name} stops and starts every App that uses what it backs up; you need permission to stop each`
    )
  }
}

// The App and volume targets a stopped backup step runs on.
function stoppedBackups(
  actions: ReadonlyArray<ScheduleAction>,
  targets: ReadonlyArray<ScheduleTarget>
): Array<ScheduleTarget> {
  const found = new Map<string, ScheduleTarget>()
  for (const action of actions) {
    if (action.type !== "backup" || action.consistency !== "stopped") continue
    for (const target of targets) {
      if (
        (target.kind === "app" || target.kind === "volume") &&
        scheduleActionAppliesToTarget(action, target)
      )
        found.set(scheduleTargetKey(target), target)
    }
  }
  return [...found.values()]
}
