import { availableParallelism, totalmem } from "node:os"

import {
  CPU_LIMIT_MILLIS_PER_CORE,
  relayDiskAllocationAvailableBytes,
  type ResourceLimits,
} from "@workspace/contracts"

import type { ContainerSpec } from "./docker-container-spec.js"

// Resource limits for any container the Relay creates. Docker keeps the
// memory and CPU limits in the container's HostConfig, so those are read
// back from it. Kiln enforces disk limits itself, so a label records them.

/** The disk limit Kiln enforces: bytes, or `none`. */
export const DISK_LIMIT_LABEL = "kiln.limits.disk-bytes"

const NANO_CPUS_PER_MILLI = 1_000_000

/** The memory and CPU parts of a container's spec. */
export function containerLimitSpec(
  limits: ResourceLimits
): Pick<ContainerSpec, "memory" | "memorySwap" | "nanoCpus"> {
  return {
    // A swap limit equal to memory leaves the container no swap.
    ...(limits.memoryBytes !== null && {
      memory: String(limits.memoryBytes),
      memorySwap: String(limits.memoryBytes),
    }),
    ...(limits.cpuMillis !== null && {
      nanoCpus: limits.cpuMillis * NANO_CPUS_PER_MILLI,
    }),
  }
}

export function resourceLimitLabels(
  limits: ResourceLimits
): Record<string, string> {
  return {
    [DISK_LIMIT_LABEL]:
      limits.diskBytes === null ? "none" : String(limits.diskBytes),
  }
}

/**
 * The limits a container runs with. A container without a disk label takes
 * `fallbackDiskBytes`: older game servers recorded theirs elsewhere.
 */
export function containerResourceLimits(
  container: {
    readonly Config?: {
      readonly Labels?: Record<string, string | undefined> | null
    }
    readonly HostConfig?: {
      readonly Memory?: number
      readonly NanoCpus?: number
    } | null
  },
  fallbackDiskBytes: number | null = null
): ResourceLimits {
  const memory = container.HostConfig?.Memory ?? 0
  const nanoCpus = container.HostConfig?.NanoCpus ?? 0
  return {
    cpuMillis: nanoCpus > 0 ? Math.round(nanoCpus / NANO_CPUS_PER_MILLI) : null,
    diskBytes: diskLimitLabel(
      container.Config?.Labels?.[DISK_LIMIT_LABEL],
      fallbackDiskBytes
    ),
    memoryBytes: memory > 0 ? memory : null,
  }
}

function diskLimitLabel(
  value: string | undefined,
  fallback: number | null
): number | null {
  if (value === "none") return null
  if (!value || !/^\d+$/u.test(value)) return fallback
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : fallback
}

export interface ResourceAllocation {
  readonly id: string
  readonly limits: ResourceLimits
}

/**
 * Every instance's limits on this node, whatever its kind, so limits set on
 * one kind leave room for the others. Each kind registers where its limits
 * come from.
 */
/**
 * The larger of two sets of limits, field by field, for what to hold while
 * one gives way to the other. No limit holds nothing.
 */
export function widestResourceLimits(
  current: ResourceLimits,
  next: ResourceLimits
): ResourceLimits {
  const widest = (key: keyof ResourceLimits) =>
    current[key] === null
      ? next[key]
      : next[key] === null
        ? current[key]
        : Math.max(current[key], next[key])
  return {
    cpuMillis: widest("cpuMillis"),
    diskBytes: widest("diskBytes"),
    memoryBytes: widest("memoryBytes"),
  }
}

export class ResourceAllocations {
  readonly #sources = new Map<
    string,
    () => Promise<ReadonlyArray<ResourceAllocation>>
  >()
  // Limits held for instances whose containers are being replaced or
  // created, newest last.
  readonly #reservations: Array<{
    readonly id: string
    readonly kind: string
    readonly limits: ResourceLimits
  }> = []

  register(
    kind: string,
    source: () => Promise<ReadonlyArray<ResourceAllocation>>
  ): void {
    this.#sources.set(kind, source)
  }

  /**
   * Holds an instance's limits until the returned release, standing in for
   * whatever its containers report meanwhile, so a container briefly gone
   * during a replacement frees nothing. Take it holding the allocations
   * lane, after checking the limits fit.
   */
  reserve(kind: string, id: string, limits: ResourceLimits): () => void {
    const reservation = { id, kind, limits }
    this.#reservations.push(reservation)
    return () => {
      const index = this.#reservations.indexOf(reservation)
      if (index !== -1) this.#reservations.splice(index, 1)
    }
  }

  /** The limits of every instance but this one. */
  async others(
    kind: string,
    id: string
  ): Promise<ReadonlyArray<ResourceLimits>> {
    const key = (entryKind: string, entryId: string) =>
      `${entryKind}:${entryId}`
    // One reservation counts per instance, its newest.
    const reserved = new Map(
      this.#reservations.map((reservation) => [
        key(reservation.kind, reservation.id),
        reservation.limits,
      ])
    )
    reserved.delete(key(kind, id))
    const lists = await Promise.all(
      [...this.#sources].map(async ([sourceKind, source]) =>
        (await source()).flatMap((allocation) =>
          (sourceKind === kind && allocation.id === id) ||
          reserved.has(key(sourceKind, allocation.id))
            ? []
            : [allocation.limits]
        )
      )
    )
    return [...lists.flat(), ...reserved.values()]
  }
}

/**
 * Refuses limits the node can't honor. Memory and disk are reserved: every
 * container's limit counts against the node's total. CPU is shared, so a
 * limit only has to fit the node's cores.
 */
export function assertResourceLimitsFit(input: {
  /** The instance's current disk limit, which it may keep. */
  readonly currentDiskBytes: number | null
  readonly limits: ResourceLimits
  readonly nodeDiskBytes: number
  /** Limits of every other container on the node. */
  readonly others: ReadonlyArray<ResourceLimits>
}): void {
  const { limits } = input
  const cores = availableParallelism()
  if (
    limits.cpuMillis !== null &&
    limits.cpuMillis > cores * CPU_LIMIT_MILLIS_PER_CORE
  ) {
    throw new Error(
      `CPU limit exceeds the node's ${cores} ${cores === 1 ? "core" : "cores"}`
    )
  }
  if (limits.memoryBytes !== null) {
    const allocated = sumLimit(input.others, "memoryBytes")
    if (allocated + limits.memoryBytes > totalmem()) {
      throw new Error(
        `Memory limit exceeds the node's assignable capacity (${formatAllocationBytes(Math.max(totalmem() - allocated, 0))} available)`
      )
    }
  }
  if (limits.diskBytes !== null) {
    const available = relayDiskAllocationAvailableBytes(
      input.nodeDiskBytes,
      sumLimit(input.others, "diskBytes"),
      input.currentDiskBytes ?? 0
    )
    if (limits.diskBytes > available) {
      throw new Error(
        `Disk limit exceeds the node's assignable capacity (${formatAllocationBytes(available)} available after the 10 GiB node reserve)`
      )
    }
  }
}

function sumLimit(
  limits: ReadonlyArray<ResourceLimits>,
  key: "diskBytes" | "memoryBytes"
): number {
  return limits.reduce((total, current) => total + (current[key] ?? 0), 0)
}

export function formatAllocationBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GiB`
}
