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

/** What a node can still give an instance, for those who may see it. */
export type ResourceLimitsCapacity = {
  /** Memory and disk its limits can still take, past every instance's. */
  assignableDiskBytes: number
  assignableMemoryBytes: number
  cores: number
}

/**
 * One limit as its input holds it. Turning the limit off keeps the value, so
 * turning it back on restores it.
 */
export type ResourceLimitDraft = { limited: boolean; value: string }

/** Limits as the sliders hold them, in cores and GiB. */
export type ResourceLimitsDraft = {
  cpuCores: ResourceLimitDraft
  diskGiB: ResourceLimitDraft
  memoryGiB: ResourceLimitDraft
}

export type ResourceLimitField = keyof ResourceLimitsDraft

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
  return `${Number(((millis / CPU_LIMIT_MILLIS_PER_CORE) * 100).toFixed(1))}%`
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
):
  | { limits: ResourceLimits }
  | { error: string; field: ResourceLimitField | null } {
  const memoryBytes = parseGibibytes(draft.memoryGiB)
  if (
    memoryBytes === undefined ||
    (memoryBytes !== null && memoryBytes < MINIMUM_MEMORY_LIMIT_BYTES)
  ) {
    return {
      error: `Enter a memory limit of at least ${formatBytes(MINIMUM_MEMORY_LIMIT_BYTES)}.`,
      field: "memoryGiB",
    }
  }
  const diskBytes = parseGibibytes(draft.diskGiB)
  if (
    diskBytes === undefined ||
    (diskBytes !== null && diskBytes < MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
  ) {
    return {
      error: `Enter a disk limit of at least ${formatBytes(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)}.`,
      field: "diskGiB",
    }
  }
  const cpuMillis = parseCores(draft.cpuCores)
  if (
    cpuMillis === undefined ||
    (cpuMillis !== null && cpuMillis < MINIMUM_CPU_LIMIT_MILLIS)
  ) {
    return {
      error: `Enter a CPU limit of at least ${formatCpuLimit(MINIMUM_CPU_LIMIT_MILLIS)}.`,
      field: "cpuCores",
    }
  }
  const limits = { cpuMillis, diskBytes, memoryBytes }
  const overCapacity = resourceLimitsCapacityError(capacity, limits)
  return overCapacity ?? { limits }
}

/** A draft's memory limit in bytes, when it holds one. */
export function draftMemoryBytes(draft: ResourceLimitsDraft): number | null {
  return parseGibibytes(draft.memoryGiB) ?? null
}

function resourceLimitsCapacityError(
  capacity: ResourceLimitsCapacity | null,
  limits: ResourceLimits
): { error: string; field: ResourceLimitField } | null {
  if (capacity === null) return null
  const nodeCpuMillis = capacity.cores * CPU_LIMIT_MILLIS_PER_CORE
  if (limits.cpuMillis !== null && limits.cpuMillis > nodeCpuMillis) {
    return {
      error: `The CPU limit exceeds the node's ${formatCpuLimit(nodeCpuMillis)}.`,
      field: "cpuCores",
    }
  }
  if (
    limits.memoryBytes !== null &&
    limits.memoryBytes > capacity.assignableMemoryBytes
  ) {
    return {
      error: `The memory limit exceeds the ${formatBytes(capacity.assignableMemoryBytes)} this node can assign.`,
      field: "memoryGiB",
    }
  }
  if (
    limits.diskBytes !== null &&
    limits.diskBytes > capacity.assignableDiskBytes
  ) {
    return {
      error: `The disk limit exceeds the ${formatBytes(capacity.assignableDiskBytes)} this node can assign.`,
      field: "diskGiB",
    }
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
