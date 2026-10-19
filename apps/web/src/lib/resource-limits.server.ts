import {
  relayResourceLimitsV1Feature,
  type ResourceLimits,
  type ResourceLimitsInput,
} from "@workspace/contracts"

import { relayConnectionFeatures } from "@/lib/relay-connection"

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
