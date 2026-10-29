/**
 * Live usage of Apps and databases, sampled from their containers as game
 * servers' are, at the same cadence and with the same history.
 *
 * Each snapshot tick lists their containers once, from the labels Relay
 * gives them, and samples each running one in the background. An App's usage
 * is its services' together, and each service's is its containers', so a
 * service mid-deployment counts both its old and new containers.
 */
import { cpus, totalmem } from "node:os"

import type {
  RelayInstanceResources,
  RelayWorkloadResourceKind,
  RelayWorkloadUsage,
  RelayWorkloadUsageHistory,
  ResourceLimits,
} from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import type { DockerEngine } from "./docker-engine.js"
import { APP_SERVICE, relayOwnsLabels } from "./relay-resources.js"
import { containerResourceLimits } from "./resource-limits.js"
import {
  containerCpuAndMemory,
  containerNetwork,
  percentOf,
  ResourceSamples,
  roundPercent,
  type DockerStats,
} from "./resource-samples.js"

export type WorkloadKind = RelayWorkloadResourceKind

interface WorkloadContainer {
  readonly containerId: string
  readonly id: string
  readonly kind: WorkloadKind
  readonly running: boolean
  // An App's service; null for a database.
  readonly service: string | null
}

// Limits change rarely, and only through Relay, so a container's are read
// again only this often.
const LIMITS_REFRESH_MS = 60_000

// Neither App nor database containers have a disk Relay measures here.
const NO_STORAGE: RelayInstanceResources["storage"] = {
  nodePercent: 0,
  nodeTotalBytes: 0,
  nodeUsedBytes: 0,
  percent: null,
  totalBytes: 0,
  usedBytes: null,
}

export class WorkloadResources {
  readonly #config: Pick<RelayConfig, "resourceNamespace">
  readonly #engine: DockerEngine
  #containers: ReadonlyArray<WorkloadContainer> = []
  #listing = false
  readonly #limits = new Map<
    string,
    { readonly at: number; readonly limits: ResourceLimits }
  >()
  readonly #samples: Record<WorkloadKind, ResourceSamples> = {
    app: new ResourceSamples("app"),
    database: new ResourceSamples("database"),
  }

  constructor(
    config: Pick<RelayConfig, "resourceNamespace">,
    engine: DockerEngine
  ) {
    this.#config = config
    this.#engine = engine
  }

  /**
   * Lists Apps' and databases' containers and samples the running ones in
   * the background. The Relay calls it each snapshot tick.
   */
  tick(): void {
    if (this.#listing) return
    this.#listing = true
    Effect.runFork(
      this.#engine
        .listContainers({
          all: true,
          filters: { label: ["kiln.resource.kind"] },
        })
        .pipe(
          Effect.map((listed) => {
            this.#containers = listed.flatMap((container) =>
              this.#workloadContainer(container)
            )
            this.#sample()
          }),
          // Observational: Docker being away keeps the last samples.
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              this.#listing = false
            })
          )
        )
    )
  }

  /**
   * A resource's usage now; an App's by service too. History comes for the
   * resource or for one service at a time, as `history` asks, so no answer
   * carries more than one window of it.
   */
  usage(
    kind: WorkloadKind,
    id: string,
    history: RelayWorkloadUsageHistory = "resource"
  ): RelayWorkloadUsage {
    const samples = this.#samples[kind]
    const services =
      kind === "app"
        ? [
            ...new Set(
              this.#containers.flatMap((container) =>
                container.kind === "app" &&
                container.id === id &&
                container.service !== null
                  ? [container.service]
                  : []
              )
            ),
          ].sort()
        : []
    return {
      history: history === "resource" ? samples.history(id) : [],
      resources: samples.latest(id),
      services: services.map((service) => ({
        history:
          typeof history === "object" && history.service === service
            ? samples.history(serviceKey(id, service))
            : [],
        resources: samples.latest(serviceKey(id, service)),
        service,
      })),
    }
  }

  #workloadContainer(container: {
    readonly Id: string
    readonly Labels: Readonly<Record<string, string>> | null
    readonly State: string
  }): Array<WorkloadContainer> {
    const labels = container.Labels ?? {}
    if (!relayOwnsLabels(this.#config, labels)) return []
    const kind = labels["kiln.resource.kind"]
    const id =
      kind === "app"
        ? labels["kiln.app.id"]
        : kind === "database"
          ? labels["kiln.database.id"]
          : undefined
    if (!id || (kind !== "app" && kind !== "database")) return []
    return [
      {
        containerId: container.Id,
        id,
        kind,
        running: container.State === "running",
        service:
          kind === "app" ? (labels["kiln.app.service"] ?? APP_SERVICE) : null,
      },
    ]
  }

  // Samples each container, then records each resource's usage from its
  // containers' latest samples.
  #sample(): void {
    // What the node has, which no resource's containers use more than.
    const node = {
      cpuPercent: Math.max(cpus().length, 1) * 100,
      memoryBytes: totalmem(),
    }
    for (const kind of ["app", "database"] as const) {
      const samples = this.#samples[kind]
      const keep = new Set<string>()
      const latest = new Map<string, Array<RelayInstanceResources>>()
      for (const container of this.#containers) {
        if (container.kind !== kind) continue
        const key = containerKey(container.containerId)
        keep.add(key)
        const value = samples.observe(
          key,
          container.running ? container.containerId : null,
          (previous) => this.#sampleContainer(container.containerId, previous)
        )
        const owners =
          container.service === null
            ? [container.id]
            : [container.id, serviceKey(container.id, container.service)]
        for (const owner of owners) {
          keep.add(owner)
          const values = latest.get(owner) ?? []
          if (value) values.push(value)
          latest.set(owner, values)
        }
      }
      for (const [owner, values] of latest) {
        samples.record(owner, combined(values, node))
      }
      samples.retain(keep)
    }
    const present = new Set(
      this.#containers.map((container) => container.containerId)
    )
    for (const containerId of this.#limits.keys()) {
      if (!present.has(containerId)) this.#limits.delete(containerId)
    }
  }

  async #sampleContainer(
    containerId: string,
    previous: RelayInstanceResources | null
  ): Promise<RelayInstanceResources> {
    const [stats, limits] = await Promise.all([
      Effect.runPromise(this.#engine.containerStats(containerId)) as Promise<
        DockerStats
      >,
      this.#containerLimits(containerId),
    ])
    const sampledAt = Date.now()
    return {
      sampledAt: new Date(sampledAt).toISOString(),
      ...containerCpuAndMemory(stats, limits),
      storage: NO_STORAGE,
      network: containerNetwork(stats, previous, sampledAt),
    }
  }

  async #containerLimits(containerId: string): Promise<ResourceLimits> {
    const cached = this.#limits.get(containerId)
    if (cached && Date.now() - cached.at < LIMITS_REFRESH_MS) {
      return cached.limits
    }
    const limits = containerResourceLimits(
      await Effect.runPromise(this.#engine.inspectContainer(containerId))
    )
    this.#limits.set(containerId, { at: Date.now(), limits })
    return limits
  }
}

function containerKey(containerId: string): string {
  return `container:${containerId}`
}

function serviceKey(appId: string, service: string): string {
  return `${appId}/${service}`
}

/**
 * Several containers' usage as one: their CPU, memory, and traffic added
 * up, against no more than the node has. Null when none is running.
 */
function combined(
  values: ReadonlyArray<RelayInstanceResources>,
  node: { readonly cpuPercent: number; readonly memoryBytes: number }
): RelayInstanceResources | null {
  if (values.length === 0) return null
  if (values.length === 1) return values[0] ?? null
  const nodeCpu = node.cpuPercent
  const nodeMemory = node.memoryBytes
  const sum = (read: (value: RelayInstanceResources) => number) =>
    values.reduce((total, value) => total + read(value), 0)
  const memoryTotal = Math.min(
    sum((value) => value.memory.totalBytes),
    nodeMemory
  )
  const memoryUsed = Math.min(
    sum((value) => value.memory.usedBytes),
    memoryTotal
  )
  const sampledAt = values
    .map((value) => value.sampledAt)
    .reduce((latest, value) => (value > latest ? value : latest))
  return {
    sampledAt,
    cpu: {
      capacityPercent: Math.min(
        sum((value) => value.cpu.capacityPercent),
        nodeCpu
      ),
      percent: roundPercent(sum((value) => value.cpu.percent)),
    },
    memory: {
      totalBytes: memoryTotal,
      usedBytes: memoryUsed,
      percent: roundPercent(percentOf(memoryUsed, memoryTotal)),
    },
    storage: NO_STORAGE,
    network: {
      receivedBytes: sum((value) => value.network?.receivedBytes ?? 0),
      receivedBytesPerSecond: sum(
        (value) => value.network?.receivedBytesPerSecond ?? 0
      ),
      sentBytes: sum((value) => value.network?.sentBytes ?? 0),
      sentBytesPerSecond: sum(
        (value) => value.network?.sentBytesPerSecond ?? 0
      ),
    },
  }
}
