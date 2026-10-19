import { z } from "zod"

import { MINIMUM_INSTANCE_DISK_LIMIT_BYTES } from "./instance-limits.js"

// Resource limits every kind of instance shares: game servers, databases,
// and apps. Each applies to one container; an app with several services
// carries one set per service. `null` means no limit.

export const MINIMUM_MEMORY_LIMIT_BYTES = 64 * 1024 ** 2
/** A thousandth of a CPU core, so 1500 is one and a half cores. */
export const MINIMUM_CPU_LIMIT_MILLIS = 100
export const CPU_LIMIT_MILLIS_PER_CORE = 1000

export const resourceLimitsSchema = z
  .object({
    cpuMillis: z.number().int().min(MINIMUM_CPU_LIMIT_MILLIS).nullable(),
    diskBytes: z
      .number()
      .int()
      .min(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
      .nullable(),
    memoryBytes: z.number().int().min(MINIMUM_MEMORY_LIMIT_BYTES).nullable(),
  })
  .strict()

/**
 * Limits a create or update request asks for. A missing field keeps the
 * current limit, or takes the kind's default for a new instance.
 */
export const resourceLimitsInputSchema = resourceLimitsSchema.partial()

/**
 * Limits a Relay reports for an instance. Lenient, since a container can
 * carry limits Kiln didn't set; a missing field is no limit.
 */
export const observedResourceLimitsSchema = z.object({
  cpuMillis: z.number().int().positive().nullable().default(null),
  diskBytes: z.number().int().positive().nullable().default(null),
  memoryBytes: z.number().int().positive().nullable().default(null),
})

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>
export type ResourceLimitsInput = z.infer<typeof resourceLimitsInputSchema>
export type ResourceLimitKey = keyof ResourceLimits

export const NO_RESOURCE_LIMITS: ResourceLimits = {
  cpuMillis: null,
  diskBytes: null,
  memoryBytes: null,
}

export function resolveResourceLimits(
  current: ResourceLimits,
  input: ResourceLimitsInput | undefined
): ResourceLimits {
  return {
    cpuMillis:
      input?.cpuMillis === undefined ? current.cpuMillis : input.cpuMillis,
    diskBytes:
      input?.diskBytes === undefined ? current.diskBytes : input.diskBytes,
    memoryBytes:
      input?.memoryBytes === undefined
        ? current.memoryBytes
        : input.memoryBytes,
  }
}

export function resourceLimitsEqual(
  left: ResourceLimits,
  right: ResourceLimits
): boolean {
  return (
    left.cpuMillis === right.cpuMillis &&
    left.diskBytes === right.diskBytes &&
    left.memoryBytes === right.memoryBytes
  )
}
