import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayDiskAllocationAvailableBytes,
} from "@workspace/contracts"

/**
 * Assigns disk quotas to containers created before quotas were recorded in
 * labels, without letting them oversubscribe what the node can still offer.
 */
export function legacyDiskLimitAssignments(
  instances: ReadonlyArray<{
    configuredLimitBytes: number | null
    id: string
  }>,
  nodeTotalBytes: number
): ReadonlyMap<string, number> {
  const assignments = new Map(
    instances.flatMap(({ configuredLimitBytes, id }) =>
      configuredLimitBytes === null || configuredLimitBytes === 0
        ? []
        : [[id, configuredLimitBytes] as const]
    )
  )
  const configuredBytes = [...assignments.values()].reduce(
    (total, limitBytes) => total + limitBytes,
    0
  )
  let remainingBytes = relayDiskAllocationAvailableBytes(
    nodeTotalBytes,
    configuredBytes
  )
  const legacyInstances = instances
    .filter(
      ({ configuredLimitBytes }) =>
        configuredLimitBytes === null || configuredLimitBytes === 0
    )
    .sort((left, right) => left.id.localeCompare(right.id))

  for (const { id } of legacyInstances) {
    const remainingLimitBytes = Math.min(
      DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
      remainingBytes
    )
    const limitBytes =
      remainingLimitBytes >= MINIMUM_INSTANCE_DISK_LIMIT_BYTES
        ? remainingLimitBytes
        : DEFAULT_INSTANCE_DISK_LIMIT_BYTES
    assignments.set(id, limitBytes)
    remainingBytes = Math.max(remainingBytes - limitBytes, 0)
  }
  return assignments
}
