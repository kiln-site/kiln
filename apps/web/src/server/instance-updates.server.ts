import { Effect } from "effect"

import {
  autoBrickUpdateAt,
  autoUpdateAt,
  currentImageUpdate,
  defaultInstanceUpdatePolicy,
  loadInstanceUpdateEffect,
  saveInstanceUpdatePolicyEffect,
  skipInstanceBrickUpdateEffect,
  skipInstanceUpdateEffect,
  type InstanceUpdate,
  type InstanceUpdateKind,
  type InstanceUpdateMode,
} from "@/effect/instance-updates"
import {
  publishNotificationChange,
  resolveNotificationsEffect,
} from "@/effect/notifications"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { updatedKind } from "@/lib/instance-update-kinds.server"
import {
  askInstanceImageEffect,
  recheckInstanceImage,
  recordCheckedImageEffect,
  resolveInstanceUpdateNotificationsEffect,
  type InstanceImageAnswer,
} from "@/lib/instance-updates.server"
import { requiredRelay } from "@/server/managed-database-access"

// What people who can deploy an instance decide about its updates. Each one
// changes what Kiln does next for everyone who sees the instance.

export interface UpdatedInstanceInput {
  instanceId: string
  kind: InstanceUpdateKind
  relayId: string
}

/**
 * What an instance's Updates row shows: its saved policy, and what the last
 * check found, if that still describes it (`currentImageUpdate`). `image`
 * is the one it names, when Hearth knows; otherwise the one last checked.
 */
export function updatesView(
  image: string | null,
  saved: InstanceUpdate | null,
  current: InstanceUpdate | null
) {
  const policy = {
    delayHours: saved?.delayHours ?? defaultInstanceUpdatePolicy.delayHours,
    mode: saved?.mode ?? defaultInstanceUpdatePolicy.mode,
  }
  const named = image ?? current?.image ?? null
  // A digest never moves, so there's nothing to check.
  const pinned = named?.includes("@") ?? false
  return {
    ...policy,
    // Its Brick's revision, which a deployment doesn't make stale as it
    // does an image's digest: only a check says another.
    brick: saved?.brick
      ? {
          autoUpdateAt: autoBrickUpdateAt(saved),
          latestRevision: saved.brick.latestRevision,
          latestSeenAt: saved.brick.latestSeenAt,
          revision: saved.brick.revision,
          skippedRevision: saved.brick.skippedRevision,
        }
      : null,
    autoUpdateAt: current && autoUpdateAt(current),
    checkError: current?.checkError ?? null,
    checkedAt: current?.checkedAt ?? null,
    image: named,
    latestDigest: current?.latestDigest ?? null,
    latestSeenAt: current?.latestSeenAt ?? null,
    pinned,
    runningDigest: current?.runningDigest ?? null,
    skippedDigest: current?.skippedDigest ?? null,
    state: pinned ? null : (current?.state ?? null),
  }
}

export type InstanceUpdatesView = ReturnType<typeof updatesView>

/** An instance's updates, for whoever can read it; null if it has none. */
export async function instanceUpdatesHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput
): Promise<InstanceUpdatesView | null> {
  const adapter = updatedKind(data.kind)
  await requireRelayPermission({
    [`${adapter.resourceType}Id`]: data.instanceId,
    permission: `${adapter.resourceType}.read`,
    relayId: data.relayId,
    user,
  })
  const [named, saved, startedAt] = await Promise.all([
    runAppEffect(
      "instances.updates.named",
      adapter.namedImage(data.relayId, data.instanceId)
    ),
    runAppEffect(
      "instances.updates.load",
      loadInstanceUpdateEffect(data.instanceId)
    ),
    runAppEffect(
      "instances.updates.latestDeployment",
      adapter.latestDeploymentStartedAt(data.instanceId)
    ),
  ])
  if (named === undefined) return null
  return updatesView(named, saved, currentImageUpdate(saved, named, startedAt))
}

// The Relay it is on, once it's known to be something that checks.
async function updatedInstance(data: UpdatedInstanceInput) {
  const relay = await requiredRelay(data.relayId)
  const named = await runAppEffect(
    "instances.updates.named",
    updatedKind(data.kind).namedImage(relay.id, data.instanceId)
  )
  if (named === undefined) {
    throw new Error(
      data.kind === "app"
        ? "Only Apps deployed from an image tag check for updates"
        : "This doesn't check for updates"
    )
  }
  return relay
}

/**
 * Turns checks off, or on to notify or deploy once an update has waited.
 * Turned on, the instance is checked now rather than within the hour.
 */
export async function saveInstanceUpdatePolicyHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput & { delayHours: number; mode: InstanceUpdateMode }
) {
  const relay = await updatedInstance(data)
  await runAppEffect(
    "instances.updates.policy",
    saveInstanceUpdatePolicyEffect(data.kind, data.instanceId, {
      delayHours: data.delayHours,
      mode: data.mode,
    })
  )
  if (data.mode !== "off") {
    recheckInstanceImage(data.kind, relay.id, data.instanceId, user.id)
  } else {
    await runAppEffect(
      "instances.updates.policy.resolveNotifications",
      resolveInstanceUpdateNotificationsEffect(
        data.kind,
        relay.id,
        data.instanceId,
        { unchecked: true }
      )
    )
  }
  updatedKind(data.kind).published(relay.id)
}

/**
 * Asks about the instance's tag now, holding no lane while registries
 * answer; `recordInstanceImageCheckHandler` records the answer holding the
 * instance. Whoever may deploy it may ask.
 */
export async function askInstanceImageUpdateHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput
) {
  const { resourceType } = updatedKind(data.kind)
  await requireRelayPermission({
    [`${resourceType}Id`]: data.instanceId,
    permission: "instance.deploy",
    relayId: data.relayId,
    user,
  })
  const relay = await updatedInstance(data)
  return runAppEffect(
    "instances.updates.ask",
    askInstanceImageEffect(data.kind, relay, data.instanceId)
  )
}

export async function recordInstanceImageCheckHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput & {
    asked: { answers: ReadonlyArray<InstanceImageAnswer>; unchecked: boolean }
  }
) {
  const relay = await updatedInstance(data)
  await runAppEffect(
    "instances.updates.record",
    recordCheckedImageEffect(
      data.kind,
      relay,
      data.instanceId,
      data.asked,
      user.id
    )
  )
  updatedKind(data.kind).published(relay.id)
}

/** Passes over the update on offer: it neither notifies nor deploys. */
export async function skipInstanceUpdateHandler(
  _user: AuthenticatedUser,
  data: UpdatedInstanceInput & { digest: string }
) {
  const relay = await updatedInstance(data)
  const skipped = await runAppEffect(
    "instances.updates.skip",
    skipInstanceUpdateEffect(data.instanceId, data.digest)
  )
  if (!skipped) throw new Error("That update is no longer on offer")
  await runAppEffect(
    "instances.updates.skip.resolveNotifications",
    resolveInstanceUpdateNotificationsEffect(
      data.kind,
      relay.id,
      data.instanceId
    )
  )
  updatedKind(data.kind).published(relay.id)
}

/** Passes over the Brick revision on offer. */
export async function skipInstanceBrickUpdateHandler(
  _user: AuthenticatedUser,
  data: UpdatedInstanceInput & { revision: number }
) {
  const relay = await updatedInstance(data)
  const skipped = await runAppEffect(
    "instances.updates.skipBrick",
    skipInstanceBrickUpdateEffect(data.instanceId, data.revision)
  )
  if (!skipped) throw new Error("That revision is no longer on offer")
  // Its notification has nothing left to offer.
  await runAppEffect(
    "instances.updates.skipBrick.resolveNotifications",
    resolveNotificationsEffect("instance.brick-update", [
      `instance.brick-update:${data.instanceId}:${data.revision}`,
    ]).pipe(Effect.map(publishNotificationChange))
  )
  updatedKind(data.kind).published(relay.id)
}

/**
 * Installs the newer revision of its Brick now, skipped or not, whatever
 * its wait, with the answers the instance already has.
 */
export async function installInstanceBrickHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput
) {
  const relay = await updatedInstance(data)
  const adapter = updatedKind(data.kind)
  const brick = (
    await runAppEffect(
      "instances.updates.load",
      loadInstanceUpdateEffect(data.instanceId)
    )
  )?.brick
  if (!adapter.installBrick || !brick || brick.latestRevision === null) {
    throw new Error("Its Brick has no newer revision on offer")
  }
  await runAppEffect(
    "instances.updates.installBrick",
    adapter.installBrick(relay, data.instanceId, user.id, {
      revision: brick.latestRevision,
      source: brick.source,
    })
  )
  return { queued: true as const }
}

/** Deploys the update on offer now, skipped or not, whatever its wait. */
export async function deployInstanceUpdateHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput
) {
  const relay = await updatedInstance(data)
  await runAppEffect(
    "instances.updates.deploy",
    updatedKind(data.kind).deployUpdate(relay, data.instanceId, user.id, null)
  )
  return { queued: true as const }
}
