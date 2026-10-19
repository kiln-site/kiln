import {
  brickSchema,
  brickVariableValuesSchema,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type { z } from "zod"

import { runAppEffect } from "@/effect/runtime"
import {
  canReadRelayNode,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  instanceCapacity,
  relayAllocations,
} from "@/lib/resource-limits.server"
import { hydrateBrickIcon } from "@/lib/brick-catalog-source.server"
import { hydrateBrickVariables } from "@/lib/brick-variables"
import { relayJsonEffect } from "@/lib/relay-client"
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"

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
  const grants = isPlatformAdmin(user)
    ? []
    : await listUserGrants(user.id, relay.id)
  return {
    allocation: canReadRelayNode(user, relay.id, grants)
      ? instanceCapacity(
          snapshot.node,
          await relayAllocations(relay, snapshot),
          { id: instance.id, kind: "server" }
        )
      : null,
    brick,
    brickSource,
    instance: relayInstanceSchema.parse(instance),
    variables: brickVariableValuesSchema.parse(variables),
  }
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
