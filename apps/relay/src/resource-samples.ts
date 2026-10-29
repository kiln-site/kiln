/**
 * Live resource usage for every kind of resource the Relay runs: game
 * servers, Apps, databases, and the Relay itself. Each resource keeps its
 * latest sample and a window of history. Sampling runs in the background, at
 * most once per `RESOURCE_SAMPLE_INTERVAL_MS` per resource, so a slow
 * Docker answer never holds up whoever reads the latest value.
 *
 * Sampling is a hot path, so it reports through metrics, never spans.
 */
import type {
  RelayInstanceResources,
  ResourceLimits,
} from "@workspace/contracts"
import { CPU_LIMIT_MILLIS_PER_CORE } from "@workspace/contracts"
import { Effect, Metric } from "effect"

import { promiseEffect } from "./effect/promise.js"

/** How much history a resource keeps. */
export const RESOURCE_HISTORY_WINDOW_MS = 6 * 60_000
/** The shortest time between two samples of one resource. */
export const RESOURCE_SAMPLE_INTERVAL_MS = 1_500

export type ResourceSampleKind = "app" | "database" | "instance" | "relay"

const sampleDuration = Metric.histogram("relay.resources.sample.duration", {
  description: "Time one resource's usage took to sample, by how it ended",
  attributes: { unit: "s" },
  boundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
})

/** The parts of Docker's container stats the Relay reads. */
export interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number }
    online_cpus?: number
    system_cpu_usage?: number
  }
  precpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
  }
  memory_stats?: {
    limit?: number
    stats?: {
      inactive_file?: number
      total_inactive_file?: number
    }
    usage?: number
  }
  networks?: Record<
    string,
    {
      rx_bytes?: number
      tx_bytes?: number
    }
  >
}

interface Entry {
  // What was sampled, such as a container ID; a new one starts afresh.
  generation: string | null
  history: Array<RelayInstanceResources>
  lastAttempt: number
  pending: boolean
  value: RelayInstanceResources | null
}

export class ResourceSamples {
  readonly #entries = new Map<string, Entry>()
  readonly #kind: ResourceSampleKind

  constructor(kind: ResourceSampleKind) {
    this.#kind = kind
  }

  /**
   * The resource's latest sample, starting another in the background when
   * the last is old enough. `generation` names what's sampled, such as its
   * container; null when nothing runs, which clears the latest sample.
   */
  observe(
    key: string,
    generation: string | null,
    sample: (
      previous: RelayInstanceResources | null
    ) => Promise<RelayInstanceResources>
  ): RelayInstanceResources | null {
    const entry = this.#entry(key)
    if (entry.generation !== generation) {
      entry.generation = generation
      entry.value = null
    }
    if (generation === null) return null
    const now = Date.now()
    if (entry.pending || now - entry.lastAttempt < RESOURCE_SAMPLE_INTERVAL_MS)
      return entry.value
    entry.lastAttempt = now
    entry.pending = true
    const previous = entry.value
    Effect.runFork(
      promiseEffect(() => sample(previous)).pipe(
        Effect.tap((resources) =>
          Effect.sync(() => {
            // Replaced while it sampled: the sample is of what's gone.
            if (entry.generation !== generation) return
            entry.value = resources
            this.#remember(entry, resources)
          })
        ),
        Effect.onExit((exit) =>
          this.#measure(
            Date.now() - now,
            exit._tag === "Success" ? "sampled" : "failed"
          )
        ),
        // Observational: a slow or failing Docker keeps the last value.
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            entry.lastAttempt = Date.now()
            entry.pending = false
          })
        )
      )
    )
    return entry.value
  }

  /** Keeps a sample made of others, such as an App's from its services. */
  record(key: string, resources: RelayInstanceResources | null): void {
    const entry = this.#entry(key)
    entry.value = resources
    if (resources && resources.sampledAt !== entry.history.at(-1)?.sampledAt)
      this.#remember(entry, resources)
  }

  latest(key: string): RelayInstanceResources | null {
    return this.#entries.get(key)?.value ?? null
  }

  history(key: string): Array<RelayInstanceResources> {
    const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS
    return (this.#entries.get(key)?.history ?? []).filter(
      (sample) => Date.parse(sample.sampledAt) >= cutoff
    )
  }

  /** Forgets every resource but these. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#entries.keys()) {
      if (!keys.has(key)) this.#entries.delete(key)
    }
  }

  #entry(key: string): Entry {
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = {
        generation: null,
        history: [],
        lastAttempt: 0,
        pending: false,
        value: null,
      }
      this.#entries.set(key, entry)
    }
    return entry
  }

  #remember(entry: Entry, resources: RelayInstanceResources): void {
    const cutoff = Date.parse(resources.sampledAt) - RESOURCE_HISTORY_WINDOW_MS
    entry.history = [...entry.history, resources].filter(
      (sample) => Date.parse(sample.sampledAt) >= cutoff
    )
  }

  #measure(
    milliseconds: number,
    outcome: "failed" | "sampled"
  ): Effect.Effect<void> {
    return Metric.update(
      Metric.withAttributes(sampleDuration, {
        "relay.resource.kind": this.#kind,
        outcome,
      }),
      milliseconds / 1_000
    )
  }
}

/** A container's CPU and memory use, against its limits or the node's. */
export function containerCpuAndMemory(
  stats: DockerStats,
  limits: Pick<ResourceLimits, "cpuMillis" | "memoryBytes">
): Pick<RelayInstanceResources, "cpu" | "memory"> {
  const cpuCurrent = stats.cpu_stats?.cpu_usage?.total_usage ?? 0
  const cpuPrevious = stats.precpu_stats?.cpu_usage?.total_usage ?? 0
  const systemCurrent = stats.cpu_stats?.system_cpu_usage ?? 0
  const systemPrevious = stats.precpu_stats?.system_cpu_usage ?? 0
  const cpuDelta = cpuCurrent - cpuPrevious
  const systemDelta = systemCurrent - systemPrevious
  const onlineCpus = Math.max(stats.cpu_stats?.online_cpus ?? 1, 1)
  const cpuPercent =
    cpuDelta > 0 && systemDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0

  const memoryTotal = Math.max(
    limits.memoryBytes ?? stats.memory_stats?.limit ?? 0,
    0
  )
  const memoryCache = Math.max(
    stats.memory_stats?.stats?.total_inactive_file ??
      stats.memory_stats?.stats?.inactive_file ??
      0,
    0
  )
  const memoryUsed = Math.max(
    Math.min((stats.memory_stats?.usage ?? 0) - memoryCache, memoryTotal),
    0
  )
  return {
    cpu: {
      // A CPU limit of 1.5 cores lets the server use up to 150%.
      capacityPercent:
        limits.cpuMillis === null
          ? onlineCpus * 100
          : limits.cpuMillis / (CPU_LIMIT_MILLIS_PER_CORE / 100),
      percent: roundPercent(cpuPercent),
    },
    memory: {
      totalBytes: memoryTotal,
      usedBytes: memoryUsed,
      percent: roundPercent(percentOf(memoryUsed, memoryTotal)),
    },
  }
}

/**
 * What a container has sent and received, and how fast since `previous`,
 * sampled at `sampledAt`. A replaced container's counters start again, which
 * reads as no traffic rather than less than none.
 */
export function containerNetwork(
  stats: DockerStats,
  previous: RelayInstanceResources | null,
  sampledAt: number
): NonNullable<RelayInstanceResources["network"]> {
  const network = Object.values(stats.networks ?? {}).reduce(
    (total, current) => ({
      receivedBytes: total.receivedBytes + (current.rx_bytes ?? 0),
      sentBytes: total.sentBytes + (current.tx_bytes ?? 0),
    }),
    { receivedBytes: 0, sentBytes: 0 }
  )
  const previousSampledAt = previous
    ? Date.parse(previous.sampledAt)
    : Number.NaN
  const elapsedSeconds = Number.isFinite(previousSampledAt)
    ? Math.max((sampledAt - previousSampledAt) / 1_000, 0)
    : 0
  const rate = (current: number, before: number | undefined) =>
    before !== undefined && elapsedSeconds > 0
      ? Math.max((current - before) / elapsedSeconds, 0)
      : 0
  return {
    ...network,
    receivedBytesPerSecond: rate(
      network.receivedBytes,
      previous?.network?.receivedBytes
    ),
    sentBytesPerSecond: rate(network.sentBytes, previous?.network?.sentBytes),
  }
}

export function percentOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}

export function roundPercent(value: number): number {
  return Math.round(Math.max(value, 0) * 10) / 10
}
