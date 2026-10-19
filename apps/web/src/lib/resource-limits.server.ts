import {
  relayDiskAllocationAvailableBytes,
  NO_RESOURCE_LIMITS,
  relayAppLimitsV1Feature,
  relayAppSchema,
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
  kind: "app" | "database" | "server"
  limits: ResourceLimits
}

/**
 * Every instance's limits on a Relay, whatever its kind: game servers from
 * its snapshot, and the rest from their own lists. An app counts each
 * container's memory and CPU, and its own disk.
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
  const features = relayConnectionFeatures(relay.id)
  if (!features.has(relayResourceLimitsV1Feature)) return servers
  const [databases, apps] = await Promise.all([
    relayRpc(relay, "database.list", {}, 30_000).then((value) =>
      z.array(relayManagedDatabaseSchema).parse(value)
    ),
    features.has(relayAppLimitsV1Feature)
      ? relayRpc(relay, "app.list", {}, 30_000).then((value) =>
          z.array(relayAppSchema).parse(value)
        )
      : [],
  ])
  return [
    ...servers,
    ...databases.map((database) => ({
      id: database.id,
      kind: "database" as const,
      limits: database.limits,
    })),
    ...apps.flatMap((app) => [
      {
        id: app.id,
        kind: "app" as const,
        limits: { ...NO_RESOURCE_LIMITS, diskBytes: app.diskLimitBytes },
      },
      ...app.containers.map((container) => ({
        id: app.id,
        kind: "app" as const,
        limits: {
          ...NO_RESOURCE_LIMITS,
          cpuMillis: container.limits?.cpuMillis ?? null,
          memoryBytes: container.limits?.memoryBytes ?? null,
        },
      })),
    ]),
  ]
}

/**
 * What the node can give one instance, given every instance's limits. An
 * instance with several entries, such as an app's containers, keeps what
 * all of them hold.
 */
export function instanceCapacity(
  node: Pick<RelayNode, "cpu" | "memory" | "storage">,
  allocations: ReadonlyArray<InstanceAllocation>,
  target: { id: string; kind: InstanceAllocation["kind"] }
): ResourceLimitsCapacity | null {
  const own = (allocation: InstanceAllocation) =>
    allocation.kind === target.kind && allocation.id === target.id
  const current = allocations.filter(own)
  if (current.length === 0) return null
  const total = (key: "diskBytes" | "memoryBytes") =>
    current.reduce((sum, allocation) => sum + (allocation.limits[key] ?? 0), 0)
  return nodeResourceCapacity(
    node,
    allocations.flatMap((allocation) =>
      own(allocation) ? [] : [allocation.limits]
    ),
    { cpuMillis: null, diskBytes: total("diskBytes"), memoryBytes: total("memoryBytes") }
  )
}
