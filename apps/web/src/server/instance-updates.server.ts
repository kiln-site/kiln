import {
  saveInstanceUpdatePolicyEffect,
  skipInstanceUpdateEffect,
  type InstanceUpdateKind,
  type InstanceUpdateMode,
} from "@/effect/instance-updates"
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

/** Deploys the update on offer now, skipped or not, whatever its wait. */
export async function deployInstanceUpdateHandler(
  user: AuthenticatedUser,
  data: UpdatedInstanceInput
) {
  const relay = await updatedInstance(data)
  await runAppEffect(
    "instances.updates.deploy",
    updatedKind(data.kind).deployUpdate(relay, data.instanceId, user.id)
  )
  return { queued: true as const }
}
