import {
  relayDiskAllocationAvailableBytes,
  relayManagedDatabaseSchema,
  relayResourceLimitsV1Feature,
  type RelayNode,
  type RelaySnapshot,
  type ResourceLimits,
  type ResourceLimitsInput,
} from "@workspace/contracts"

import { z } from "zod"

import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"
import type { ResourceLimitsCapacity } from "@/lib/resource-limits"

/**
 * What the node can give one instance: its total, less what every other
 * instance's limits hold, but never less than the instance already has.
 */
export function nodeResourceCapacity(
  node: Pick<RelayNode, "cpu" | "memory" | "storage">,
  others: ReadonlyArray<ResourceLimits>,
  current: ResourceLimits
): ResourceLimitsCapacity {
  const allocated = (key: "diskBytes" | "memoryBytes") =>
    others.reduce((total, limits) => total + (limits[key] ?? 0), 0)
  return {
    cpu: { nodeCores: node.cpu.cores },
    memory: {
      availableBytes: Math.max(
        node.memory.totalBytes - allocated("memoryBytes"),
        current.memoryBytes ?? 0
      ),
      nodeTotalBytes: node.memory.totalBytes,
      nodeUsedBytes: node.memory.usedBytes,
    },
    storage: {
      availableBytes: relayDiskAllocationAvailableBytes(
        node.storage.totalBytes,
        allocated("diskBytes"),
        current.diskBytes ?? 0
      ),
      nodeTotalBytes: node.storage.totalBytes,
      nodeUsedBytes: node.storage.usedBytes,
    },
  }
}

/**
 * The limits to send a Relay. A Relay without `resource-limits-v1` ignores
 * `limits`, so it gets the disk limit alone, and a change it can't apply
 * fails here instead of being dropped.
 */
export function relayResourceLimitsRequest(
  relayId: string,
  current: ResourceLimits,
  limits: ResourceLimitsInput | undefined
): { diskLimitBytes?: number; limits?: ResourceLimitsInput } {
  if (limits === undefined || Object.keys(limits).length === 0) return {}
  if (relayConnectionFeatures(relayId).has(relayResourceLimitsV1Feature)) {
    return { limits }
  }
  const unchanged = (key: "cpuMillis" | "memoryBytes") =>
    limits[key] === undefined || limits[key] === current[key]
  if (
    !unchanged("cpuMillis") ||
    !unchanged("memoryBytes") ||
    limits.diskBytes === null
  ) {
    throw new Error(
      "Update this Relay to change its memory or CPU limits, or to remove a limit"
    )
  }
  return limits.diskBytes === undefined
    ? {}
    : { diskLimitBytes: limits.diskBytes }
}

export type InstanceAllocation = {
  id: string
  kind: "database" | "server"
  limits: ResourceLimits
}

/**
 * Every instance's limits on a Relay, whatever its kind: game servers from
 * its snapshot, and the rest from their own lists.
 */
export async function relayAllocations(
  relay: PersistedRelay,
  snapshot: Pick<RelaySnapshot, "instances">
): Promise<Array<InstanceAllocation>> {
  const servers = snapshot.instances.map((instance) => ({
    id: instance.id,
    kind: "server" as const,
    limits: instance.limits,
  }))
  if (!relayConnectionFeatures(relay.id).has(relayResourceLimitsV1Feature)) {
    return servers
  }
  const databases = z
    .array(relayManagedDatabaseSchema)
    .parse(await relayRpc(relay, "database.list", {}, 30_000))
  return [
    ...servers,
    ...databases.map((database) => ({
      id: database.id,
      kind: "database" as const,
      limits: database.limits,
    })),
  ]
}

/** What the node can give one instance, given every instance's limits. */
export function instanceCapacity(
  node: Pick<RelayNode, "cpu" | "memory" | "storage">,
  allocations: ReadonlyArray<InstanceAllocation>,
  target: { id: string; kind: InstanceAllocation["kind"] }
): ResourceLimitsCapacity | null {
  const current = allocations.find(
    (allocation) =>
      allocation.kind === target.kind && allocation.id === target.id
  )
  if (!current) return null
  return nodeResourceCapacity(
    node,
    allocations.flatMap((allocation) =>
      allocation === current ? [] : [allocation.limits]
    ),
    current.limits
  )
}
