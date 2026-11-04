import {
  brickSchema,
  brickVariableValuesSchema,
  relayInstanceSchema,
  relaySnapshotSchema,
  relayUpdateInstanceStartupSchema,
  type RelayUpdateInstanceStartup,
  type ResourceLimits,
} from "@workspace/contracts"
import type { z } from "zod"

import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hydrateBrickIcon } from "@/lib/brick-catalog-source.server"
import { hydrateBrickVariables } from "@/lib/brick-variables"
import {
  invalidateRelayCache,
  relayCachePolicy,
  relayJsonEffect,
} from "@/lib/relay-client"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import { startupPowerPermission } from "@/lib/startup-permissions"
import { provisionInstanceDomainBestEffort } from "@/server/domains.server"

// Server-side work behind the Brick server functions in ./bricks, which
// authenticate the caller first.

export async function getInstanceStartupHandler(
  user: AuthenticatedUser,
  data: { instanceId: string; relayId: string }
) {
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({
    user,
    relayId: relay.id,
    permission: "instance.configuration.read",
    instanceId: data.instanceId,
  })
  const snapshot = relaySnapshotSchema.parse(
    await requestRelay(relay, "/v1/snapshot")
  )
  const instance = snapshot.instances.find(
    (candidate) => candidate.id === data.instanceId
  )
  if (!instance) throw new Error("Instance not found")
  const { brick, brickSource } = await loadInstanceRecipe(relay, instance)
  const variables = hydrateBrickVariables(brick, instance.variables)
  return {
    brick,
    brickSource,
    instance: relayInstanceSchema.parse(instance),
    variables: brickVariableValuesSchema.parse(variables),
  }
}

// A game server's limits are part of its container, so they apply the way
// Startup does: a running server restarts on the new ones, and a stopped one
// has them from its next start. The rest of its Startup stays as it is.
export async function updateInstanceLimitsHandler(
  user: AuthenticatedUser,
  data: { instanceId: string; limits: ResourceLimits; relayId: string }
) {
  const relay = await requiredRelay(data.relayId)
  const existing = await requiredRelayInstance(relay, data.instanceId)
  const start = existing.desiredState === "running"
  const powerPermission = startupPowerPermission(existing, { start })
  if (powerPermission) {
    await requireRelayPermission({
      instanceId: data.instanceId,
      permission: powerPermission,
      relayId: relay.id,
      user,
    })
  }
  if (!existing.variables) {
    throw new Error("Instance is missing its applied Brick variables")
  }
  return applyInstanceStartup(user, relay, data.instanceId, {
    ...relayResourceLimitsRequest(relay.id, existing.limits, data.limits),
    start,
    variables: existing.variables,
  })
}

/** Rebuilds a game server's container from `input`, and tells everyone. */
export async function applyInstanceStartup(
  user: AuthenticatedUser,
  relay: PersistedRelay,
  instanceId: string,
  input: RelayUpdateInstanceStartup
) {
  const instance = relayInstanceSchema.parse(
    await requestRelay(
      relay,
      `/v1/instances/${encodeURIComponent(instanceId)}/startup`,
      {
        method: "PUT",
        body: JSON.stringify(relayUpdateInstanceStartupSchema.parse(input)),
      },
      360_000,
      user.id
    )
  )
  await provisionInstanceDomainBestEffort(instance, relay.id)
  await runAppEffect(
    "relay.snapshot.invalidate",
    invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
  )
  publishRealtimeChange({
    instance,
    relayId: relay.id,
    type: "instance.upsert",
  })
  return instance
}

export async function requiredRelayInstance(
  relay: PersistedRelay,
  instanceId: string
) {
  const snapshot = relaySnapshotSchema.parse(
    await requestRelay(relay, "/v1/snapshot")
  )
  const instance = snapshot.instances.find(
    (candidate) => candidate.id === instanceId
  )
  if (!instance) throw new Error("Instance not found")
  return instance
}

export async function loadInstanceRecipe(
  relay: PersistedRelay,
  instance: z.infer<typeof relayInstanceSchema>
) {
  let brickSource = instance.brickSource
  if (!brickSource) {
    throw new Error("This server has no Brick recipe")
  }
  const brick = await hydrateBrickIcon(
    brickSchema.parse(
      await requestRelay(
        relay,
        `/v1/bricks/recipe?source=${encodeURIComponent(brickSource)}${
          instance.brickSnapshotSha256
            ? `&snapshotSha256=${encodeURIComponent(instance.brickSnapshotSha256)}`
            : ""
        }`
      )
    )
  )
  return { brick, brickSource }
}

export async function requiredRelay(id: string): Promise<PersistedRelay> {
  return activeRelay(id)
}

export async function requestRelay(
  relay: PersistedRelay,
  path: string,
  init?: RequestInit,
  timeout = 15_000,
  subject?: string
): Promise<unknown> {
  return runAppEffect(
    "relay.json",
    relayJsonEffect(relay, path, (input) => input, init, timeout, subject)
  )
}
