import {
  relayInstanceSchema,
  relaySnapshotSchema,
  type ResourceLimits,
} from "@workspace/contracts"

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
import type { ResourceLimitsCapacity } from "@/lib/resource-limits"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { runAppEffect } from "@/effect/runtime"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"

// What a node can still give one instance, for its limits, whatever its
// kind. Only people who may see the node's capacity get it.
export async function getResourceLimitsCapacityHandler(
  user: AuthenticatedUser,
  {
    id,
    kind,
    relayId,
  }: { id: string; kind: "app" | "database" | "server"; relayId: string }
): Promise<ResourceLimitsCapacity | null> {
  const relay = await requiredRelay(relayId)
  await requireRelayPermission({ ...readPermission(id, kind), relayId, user })
  const grants = isPlatformAdmin(user)
    ? []
    : await listUserGrants(user.id, relay.id)
  if (!canReadRelayNode(user, relay.id, grants)) return null
  const snapshot = relaySnapshotSchema.parse(
    await databaseRpc(relay, "relay.snapshot", {}, 30_000)
  )
  return instanceCapacity(
    snapshot.node,
    await relayAllocations(relay, snapshot),
    { id, kind }
  )
}

export async function saveInstanceLimits(
  user: AuthenticatedUser,
  data: { instanceId: string; limits: ResourceLimits; relayId: string }
) {
  const relay = await requiredRelay(data.relayId)
  const instance = relayInstanceSchema.parse(
    await databaseRpc(
      relay,
      "instance.limits.write",
      { instanceId: data.instanceId, limits: data.limits },
      240_000,
      user.id
    )
  )
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

function readPermission(id: string, kind: "app" | "database" | "server") {
  switch (kind) {
    case "app":
      return { appId: id, permission: "app.read" } as const
    case "database":
      return { databaseId: id, permission: "database.read" } as const
    case "server":
      return { instanceId: id, permission: "instance.read" } as const
  }
}
