import {
  CPU_LIMIT_MILLIS_PER_CORE,
  MINIMUM_CPU_LIMIT_MILLIS,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_MEMORY_LIMIT_BYTES,
  type ResourceLimits,
} from "@workspace/contracts"

import { formatBytes } from "@/lib/format-bytes"

// Memory, CPU, and disk limits as every instance's settings show and edit
// them. `null` means no limit.

export type ResourceCapacity = {
  availableBytes: number
  nodeTotalBytes: number
  nodeUsedBytes: number
}

/** What the node can still give an instance, for those who may see it. */
export type ResourceLimitsCapacity = {
  cpu: { nodeCores: number }
  memory: ResourceCapacity
  storage: ResourceCapacity
}

/**
 * One limit as its input holds it. Turning the limit off keeps the value, so
 * turning it back on restores it.
 */
export type ResourceLimitDraft = { limited: boolean; value: string }

/** Limits as the editor's inputs hold them, in cores and GiB. */
export type ResourceLimitsDraft = {
  cpuCores: ResourceLimitDraft
  diskGiB: ResourceLimitDraft
  memoryGiB: ResourceLimitDraft
}

// What an input offers when a limit is turned on for the first time.
const DRAFT_DEFAULTS = { cpuCores: "1", diskGiB: "5", memoryGiB: "2" }

const GIBIBYTE = 1024 ** 3

export function formatMemoryLimit(bytes: number | null): string {
  return bytes === null ? "No limit" : formatBytes(bytes)
}

export function formatDiskLimit(bytes: number | null): string {
  return bytes === null ? "No limit" : formatBytes(bytes)
}

export function formatCpuLimit(millis: number | null): string {
  if (millis === null) return "No limit"
  const cores = millis / CPU_LIMIT_MILLIS_PER_CORE
  return `${Number(cores.toFixed(2))} ${cores === 1 ? "core" : "cores"}`
}

export function resourceLimitsDraft(
  limits: ResourceLimits
): ResourceLimitsDraft {
  const draft = (
    value: number | null,
    input: (value: number) => string,
    fallback: string
  ) =>
    value === null
      ? { limited: false, value: fallback }
      : { limited: true, value: input(value) }
  return {
    cpuCores: draft(
      limits.cpuMillis,
      (millis) => String(millis / CPU_LIMIT_MILLIS_PER_CORE),
      DRAFT_DEFAULTS.cpuCores
    ),
    diskGiB: draft(limits.diskBytes, gibibytesInput, DRAFT_DEFAULTS.diskGiB),
    memoryGiB: draft(
      limits.memoryBytes,
      gibibytesInput,
      DRAFT_DEFAULTS.memoryGiB
    ),
  }
}

/** The limits a draft describes, or why it can't be saved. */
export function parseResourceLimitsDraft(
  draft: ResourceLimitsDraft,
  capacity: ResourceLimitsCapacity | null
): { limits: ResourceLimits } | { error: string } {
  const memoryBytes = parseGibibytes(draft.memoryGiB)
  if (
    memoryBytes === undefined ||
    (memoryBytes !== null && memoryBytes < MINIMUM_MEMORY_LIMIT_BYTES)
  ) {
    return {
      error: `Enter a memory limit of at least ${formatBytes(MINIMUM_MEMORY_LIMIT_BYTES)}.`,
    }
  }
  const diskBytes = parseGibibytes(draft.diskGiB)
  if (
    diskBytes === undefined ||
    (diskBytes !== null && diskBytes < MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
  ) {
    return {
      error: `Enter a disk limit of at least ${formatBytes(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)}.`,
    }
  }
  const cpuMillis = parseCores(draft.cpuCores)
  if (
    cpuMillis === undefined ||
    (cpuMillis !== null && cpuMillis < MINIMUM_CPU_LIMIT_MILLIS)
  ) {
    return {
      error: `Enter a CPU limit of at least ${MINIMUM_CPU_LIMIT_MILLIS / CPU_LIMIT_MILLIS_PER_CORE} cores.`,
    }
  }
  const limits = { cpuMillis, diskBytes, memoryBytes }
  const capacityError = resourceLimitsCapacityError(capacity, limits)
  return capacityError ? { error: capacityError } : { limits }
}

export function resourceLimitsCapacityError(
  capacity: ResourceLimitsCapacity | null,
  limits: ResourceLimits
): string | null {
  if (capacity === null) return null
  if (
    limits.cpuMillis !== null &&
    limits.cpuMillis > capacity.cpu.nodeCores * CPU_LIMIT_MILLIS_PER_CORE
  ) {
    return `The CPU limit exceeds the node's ${formatCpuLimit(capacity.cpu.nodeCores * CPU_LIMIT_MILLIS_PER_CORE)}.`
  }
  if (
    limits.memoryBytes !== null &&
    limits.memoryBytes > capacity.memory.availableBytes
  ) {
    return `The memory limit exceeds the ${formatBytes(capacity.memory.availableBytes)} this node can assign.`
  }
  if (
    limits.diskBytes !== null &&
    limits.diskBytes > capacity.storage.availableBytes
  ) {
    return `The disk limit exceeds the ${formatBytes(capacity.storage.availableBytes)} this node can assign.`
  }
  return null
}

/** Bytes, `null` for no limit, or `undefined` when the input isn't valid. */
function parseGibibytes({
  limited,
  value,
}: ResourceLimitDraft): number | null | undefined {
  if (!limited) return null
  const gibibytes = Number(value)
  if (value.trim() === "" || !Number.isFinite(gibibytes) || gibibytes <= 0) {
    return undefined
  }
  const bytes = Math.round(gibibytes * GIBIBYTE)
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

function parseCores({
  limited,
  value,
}: ResourceLimitDraft): number | null | undefined {
  if (!limited) return null
  const cores = Number(value)
  if (value.trim() === "" || !Number.isFinite(cores) || cores <= 0) {
    return undefined
  }
  return Math.round(cores * CPU_LIMIT_MILLIS_PER_CORE)
}

// The shortest decimal that gives back the same bytes, so an untouched
// limit saves unchanged and 0.1 GiB shows as 0.1.
function gibibytesInput(bytes: number): string {
  for (let digits = 1; digits < 17; digits += 1) {
    const gibibytes = Number((bytes / GIBIBYTE).toPrecision(digits))
    if (Math.round(gibibytes * GIBIBYTE) === bytes) return String(gibibytes)
  }
  return String(bytes / GIBIBYTE)
}
