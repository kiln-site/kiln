/**
 * What the Relay's node spends and who spends it, for sizing the room Kiln
 * keeps for itself against what workloads may take: the host's CPU, memory,
 * and pressure stalls, and each group of containers' CPU, memory, throttling,
 * OOM kills, and exits.
 *
 * Kiln's own containers (the Relay, and Hearth, its database, and its cache
 * on the host they run on, whatever deployed them) report one group each.
 * Workloads report one group per kind and everything Kiln doesn't run reports
 * as `other`, so labels stay to small fixed sets however many containers a
 * node runs.
 *
 * Sampling is a hot path, so it reports through metrics, never spans.
 */
import { readFile } from "node:fs/promises"

import type { RelayPlatformServiceRole } from "@workspace/contracts"
import { Clock, Effect, Metric } from "effect"

import type { RelayConfig } from "./config.js"
import { WORKLOAD_SLICE_LABEL } from "./docker-container-spec.js"
import type { DockerEngine } from "./docker-engine.js"
import { kilnContainerOwner } from "./kiln-containers.js"
import { platformServiceContainers } from "./platform.js"
import type { ResourceAllocations } from "./resource-limits.js"

const sampleInterval = "15 seconds"
const eventsRetryInterval = "5 seconds"
const statsConcurrency = 4
// Finding the services can inspect every container while Hearth is away from
// this host, so it runs once a minute, beside the samples rather than in them.
// Docker answers each request within 30 seconds, but a search makes many.
const serviceSearchInterval = "1 minute"
const serviceSearchTimeout = "50 seconds"

const containerGroups = [
  "relay",
  "hearth",
  "mysql",
  "valkey",
  "relay_services",
  "game_server",
  "app",
  "database",
  "other",
] as const

type ContainerGroup = (typeof containerGroups)[number]

const workloadGroups: ReadonlySet<ContainerGroup> = new Set([
  "app",
  "database",
  "game_server",
])

type OwnerConfig = Pick<
  RelayConfig,
  | "dataDirectory"
  | "installationId"
  | "mode"
  | "provenHearth"
  | "resourceNamespace"
  | "selfContainer"
  | "serverIdLabel"
>

const platformGroups: Partial<Record<string, ContainerGroup>> = {
  Relay: "relay",
  Hearth: "hearth",
  MySQL: "mysql",
  Valkey: "valkey",
}

const serviceGroups = {
  cache: "valkey",
  database: "mysql",
  hearth: "hearth",
} as const satisfies Record<RelayPlatformServiceRole, ContainerGroup>

// Which containers are Kiln's services, as last found, by container ID. Both
// the sampler and the event stream read it; a failed search keeps the last.
let serviceContainers: ReadonlyMap<string, ContainerGroup> = new Map()

const host = {
  cpuTime: counter(
    "relay.host.cpu.time",
    "CPU time the node spent, by cpu.mode, across all cores",
    "s"
  ),
  cores: gauge("relay.host.cpu.cores", "Cores the node has", "{core}"),
  memoryTotal: gauge("relay.host.memory.total", "The node's memory", "By"),
  memoryAvailable: gauge(
    "relay.host.memory.available",
    "Memory the node can give out without swapping, page cache included",
    "By"
  ),
  swapUsed: gauge("relay.host.swap.used", "Swap the node is using", "By"),
  pressure: counter(
    "relay.host.pressure.stall_time",
    "Time tasks stalled waiting for pressure.resource, as Linux's PSI reports it",
    "s"
  ),
  oomKills: counter(
    "relay.host.oom_kills",
    "Processes the kernel killed for want of memory, in or out of containers",
    "{process}"
  ),
}

const container = {
  count: gauge(
    "relay.container.count",
    "Running containers in the group",
    "{container}"
  ),
  cpuTime: counter(
    "relay.container.cpu.time",
    "CPU time the group's containers used",
    "s"
  ),
  throttledTime: counter(
    "relay.container.cpu.throttled_time",
    "Time the group's containers were held back by their CPU limits",
    "s"
  ),
  memoryUsage: gauge(
    "relay.container.memory.usage",
    "The group's container memory, page cache included",
    "By"
  ),
  memoryAnon: gauge(
    "relay.container.memory.anon",
    "The group's anonymous memory, which can't be reclaimed without swap",
    "By"
  ),
  memoryFile: gauge(
    "relay.container.memory.file",
    "The group's page cache, which the kernel can reclaim",
    "By"
  ),
  oomKills: counter(
    "relay.container.oom_kills",
    "Times a process in the group's containers was killed for want of memory",
    "{event}"
  ),
  exits: counter(
    "relay.container.exits",
    "Times one of the group's containers stopped, by exit.code",
    "{event}"
  ),
}

/** The parts of Docker's one-shot container stats the sampler reads. */
interface ContainerStats {
  readonly cpu_stats?: {
    readonly cpu_usage?: { readonly total_usage?: number }
    readonly throttling_data?: { readonly throttled_time?: number }
  }
  readonly memory_stats?: {
    readonly usage?: number
    readonly stats?: Readonly<Record<string, number | undefined>>
  }
}

interface GroupTotals {
  count: number
  cpuNanos: number
  throttledNanos: number
  usageBytes: number
  anonBytes: number
  fileBytes: number
}

/**
 * Turns readings that only grow, such as a container's CPU time, into
 * increments for a counter. The first reading of a key, and one lower than
 * the last (a restarted container or a rebooted node), set a new baseline.
 */
class Increments {
  readonly #last = new Map<string, number>()

  /** Missing readings add nothing and keep the baseline. */
  next(key: string, value: number | undefined): number {
    if (value === undefined) return 0
    const last = this.#last.get(key)
    this.#last.set(key, value)
    return last === undefined || value < last ? 0 : value - last
  }

  /** Forgets every key but these, as containers come and go. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#last.keys()) {
      if (!keys.has(key)) this.#last.delete(key)
    }
  }
}

/** Records the node's and its containers' usage every fifteen seconds. */
export function sampleNodeMetrics(
  relayId: () => string,
  engine: DockerEngine,
  config: OwnerConfig,
  allocations: Pick<ResourceAllocations, "setWorkloadsOutside">
): Effect.Effect<never> {
  const hostIncrements = new Increments()
  const containerIncrements = new Increments()
  const sampling = Effect.suspend(() => {
    const id = relayId()
    return Effect.all(
      [
        sampleHost(id, hostIncrements),
        sampleContainers(id, engine, config, containerIncrements, allocations),
      ],
      { concurrency: "unbounded", discard: true }
    )
  }).pipe(Effect.andThen(Effect.sleep(sampleInterval)), Effect.forever)
  return Effect.forkChild(findServiceContainers(engine, config)).pipe(
    Effect.andThen(sampling)
  )
}

function findServiceContainers(
  engine: DockerEngine,
  config: OwnerConfig
): Effect.Effect<never> {
  return platformServiceContainers(engine, config).pipe(
    Effect.tap((found) =>
      Effect.sync(() => {
        serviceContainers = new Map(
          [...found].map(([role, container]) => [
            container.Id,
            serviceGroups[role],
          ])
        )
      })
    ),
    Effect.timeout(serviceSearchTimeout),
    Effect.ignore,
    Effect.withTracerEnabled(false),
    Effect.andThen(Effect.sleep(serviceSearchInterval)),
    Effect.forever
  )
}

/**
 * Counts containers' OOM kills and exits as Docker reports them, for good.
 * When Docker closes the stream, listening again asks for what happened
 * from the second of the latest event, or of the first connection, and
 * skips the events it already counted. Docker only keeps its last 256
 * events, and none across its own restart, so a long gap on a busy node can
 * still lose some.
 */
export function watchContainerEvents(
  relayId: () => string,
  engine: DockerEngine,
  config: OwnerConfig
): Effect.Effect<never> {
  // Whole seconds, as Docker's `since` takes them. Events can arrive out of
  // order and share a timestamp, so what was counted is told apart by
  // container, action, and exact time, kept only for the seconds a replay
  // can repeat.
  let since: number | undefined
  const counted = new Map<string, number>()
  return Effect.gen(function* () {
    const from = since
    since ??= Math.floor((yield* Clock.currentTimeMillis) / 1000)
    yield* engine.events(
      { type: ["container"], event: ["oom", "die"] },
      { since: from },
      (event) => {
        if (event.timeNano !== undefined) {
          const identity = `${event.Actor?.ID}:${event.Action}:${event.timeNano}`
          if (counted.has(identity)) return
          const second = Number(BigInt(event.timeNano) / 1_000_000_000n)
          counted.set(identity, second)
          if (since === undefined || second > since) {
            since = second
            for (const [key, at] of counted) {
              if (at < second) counted.delete(key)
            }
          }
        }
        const attributes = event.Actor?.Attributes ?? {}
        const group = groupOf(config, {
          Id: event.Actor?.ID ?? "",
          Labels: attributes,
          Names: attributes.name ? [`/${attributes.name}`] : [],
        })
        const metric =
          event.Action === "oom"
            ? Metric.withAttributes(container.oomKills, {
                "relay.id": relayId(),
                "kiln.container.group": group,
              })
            : Metric.withAttributes(container.exits, {
                "relay.id": relayId(),
                "kiln.container.group": group,
                "exit.code": exitCode(attributes.exitCode),
              })
        Effect.runSync(Metric.update(metric, 1))
      }
    )
  }).pipe(
    // Observational: a Docker that's away or restarting is listened to again.
    Effect.ignore,
    Effect.andThen(Effect.sleep(eventsRetryInterval)),
    Effect.forever
  )
}

const sampleHost = Effect.fnUntraced(function* (
  relayId: string,
  increments: Increments
) {
  const [stat, meminfo, vmstat, cpuPressure, memoryPressure, ioPressure] =
    yield* Effect.all(
      [
        readProc("stat"),
        readProc("meminfo"),
        readProc("vmstat"),
        readProc("pressure/cpu"),
        readProc("pressure/memory"),
        readProc("pressure/io"),
      ],
      { concurrency: "unbounded" }
    )
  const at = <T>(metric: Metric.Metric<number, T>, extra = {}) =>
    Metric.withAttributes(metric, { "relay.id": relayId, ...extra })
  const updates: Array<Effect.Effect<void>> = []

  if (stat !== null) {
    const { cores, modes } = cpuTimes(stat)
    updates.push(Metric.update(at(host.cores), cores))
    for (const [mode, seconds] of modes) {
      updates.push(
        Metric.update(
          at(host.cpuTime, { "cpu.mode": mode }),
          increments.next(`cpu:${mode}`, seconds)
        )
      )
    }
  }
  if (meminfo !== null) {
    const memory = fieldValues(meminfo, ":")
    const kib = (key: string) => {
      const value = memory.get(key)
      return value === undefined ? undefined : value * 1024
    }
    const total = kib("MemTotal")
    const available = kib("MemAvailable")
    const swapTotal = kib("SwapTotal")
    const swapFree = kib("SwapFree")
    if (total !== undefined)
      updates.push(Metric.update(at(host.memoryTotal), total))
    if (available !== undefined)
      updates.push(Metric.update(at(host.memoryAvailable), available))
    if (swapTotal !== undefined && swapFree !== undefined)
      updates.push(Metric.update(at(host.swapUsed), swapTotal - swapFree))
  }
  if (vmstat !== null) {
    const kills = fieldValues(vmstat, " ").get("oom_kill")
    if (kills !== undefined)
      updates.push(
        Metric.update(at(host.oomKills), increments.next("oom", kills))
      )
  }
  for (const [resource, text] of [
    ["cpu", cpuPressure],
    ["memory", memoryPressure],
    ["io", ioPressure],
  ] as const) {
    if (text === null) continue
    for (const [scope, micros] of pressureTotals(text)) {
      updates.push(
        Metric.update(
          at(host.pressure, {
            "pressure.resource": resource,
            "pressure.scope": scope,
          }),
          increments.next(`pressure:${resource}:${scope}`, micros) / 1e6
        )
      )
    }
  }
  yield* Effect.all(updates, { discard: true })
})

const sampleContainers = Effect.fnUntraced(
  function* (
    relayId: string,
    engine: DockerEngine,
    config: OwnerConfig,
    increments: Increments,
    allocations: Pick<ResourceAllocations, "setWorkloadsOutside">
  ) {
    const listed = yield* engine.listContainers()
    allocations.setWorkloadsOutside(
      listed.filter(
        (summary) =>
          workloadGroups.has(groupOf(config, summary)) &&
          !summary.Labels?.[WORKLOAD_SLICE_LABEL]
      ).length
    )
    const sampled = yield* Effect.forEach(
      listed,
      (summary) =>
        engine.containerStats(summary.Id, { oneShot: true }).pipe(
          Effect.map((stats) => ({
            group: groupOf(config, summary),
            id: summary.Id,
            stats: stats as ContainerStats,
          })),
          // Stopped or removed since the listing.
          Effect.orElseSucceed(() => null)
        ),
      { concurrency: statsConcurrency }
    )

    const totals = new Map<ContainerGroup, GroupTotals>(
      containerGroups.map((group) => [
        group,
        {
          count: 0,
          cpuNanos: 0,
          throttledNanos: 0,
          usageBytes: 0,
          anonBytes: 0,
          fileBytes: 0,
        },
      ])
    )
    for (const entry of sampled) {
      if (entry === null) continue
      const total = totals.get(entry.group)!
      const { cpu_stats: cpu, memory_stats: memory } = entry.stats
      total.count += 1
      total.cpuNanos += increments.next(
        `${entry.id}:cpu`,
        cpu?.cpu_usage?.total_usage
      )
      total.throttledNanos += increments.next(
        `${entry.id}:throttled`,
        cpu?.throttling_data?.throttled_time
      )
      total.usageBytes += memory?.usage ?? 0
      // cgroup v2 names them anon and file. v1's total_ figures count the
      // container's nested cgroups too, which rss and cache leave out.
      const stats = memory?.stats
      total.anonBytes += stats?.anon ?? stats?.total_rss ?? stats?.rss ?? 0
      total.fileBytes += stats?.file ?? stats?.total_cache ?? stats?.cache ?? 0
    }
    // A container whose stats failed this time keeps its baselines, so its
    // next reading still counts from its last.
    increments.retain(
      new Set(listed.flatMap(({ Id }) => [`${Id}:cpu`, `${Id}:throttled`]))
    )

    // Every group is written each time, so one that empties reads zero
    // rather than keeping its last containers' values.
    yield* Effect.forEach(
      totals,
      ([group, total]) => {
        const at = <T>(metric: Metric.Metric<number, T>) =>
          Metric.withAttributes(metric, {
            "relay.id": relayId,
            "kiln.container.group": group,
          })
        return Effect.all(
          [
            Metric.update(at(container.count), total.count),
            Metric.update(at(container.cpuTime), total.cpuNanos / 1e9),
            Metric.update(
              at(container.throttledTime),
              total.throttledNanos / 1e9
            ),
            Metric.update(at(container.memoryUsage), total.usageBytes),
            Metric.update(at(container.memoryAnon), total.anonBytes),
            Metric.update(at(container.memoryFile), total.fileBytes),
          ],
          { discard: true }
        )
      },
      { discard: true }
    )
  },
  (effect) => Effect.ignore(effect)
)

function groupOf(
  config: OwnerConfig,
  summary: {
    readonly Id: string
    readonly Labels: Readonly<Record<string, string>> | null
    readonly Names: ReadonlyArray<string>
  }
): ContainerGroup {
  const service = serviceContainers.get(summary.Id)
  if (service) return service
  const owner = kilnContainerOwner(config, summary)
  if (!owner) return "other"
  switch (owner.resource.type) {
    case "instance":
      return "game_server"
    case "app":
      return "app"
    case "database":
      return "database"
    default:
      return platformGroups[owner.component ?? ""] ?? "relay_services"
  }
}

/** Exit codes past what a process can return read as `other`. */
function exitCode(value: string | undefined): string {
  const code = Number(value)
  return Number.isInteger(code) && code >= 0 && code <= 255
    ? String(code)
    : "other"
}

// /proc/stat counts in USER_HZ, which Linux fixes at 100 for userspace.
const clockTicksPerSecond = 100
const cpuModes = [
  "user",
  "nice",
  "system",
  "idle",
  "iowait",
  "irq",
  "softirq",
  "steal",
] as const

function cpuTimes(stat: string): {
  readonly cores: number
  readonly modes: ReadonlyArray<readonly [string, number]>
} {
  const lines = stat.split("\n")
  const total = lines.find((line) => line.startsWith("cpu "))
  const ticks = total?.trim().split(/\s+/).slice(1).map(Number) ?? []
  return {
    cores: lines.filter((line) => /^cpu\d/.test(line)).length,
    modes: cpuModes.flatMap((mode, index) => {
      const value = ticks[index]
      return value === undefined || !Number.isFinite(value)
        ? []
        : [[mode, value / clockTicksPerSecond] as const]
    }),
  }
}

/** Reads `key<separator> value` lines, as in /proc/meminfo and /proc/vmstat. */
function fieldValues(text: string, separator: string): Map<string, number> {
  const values = new Map<string, number>()
  for (const line of text.split("\n")) {
    const at = line.indexOf(separator)
    if (at <= 0) continue
    const value = Number.parseInt(line.slice(at + 1).trim(), 10)
    if (Number.isFinite(value)) values.set(line.slice(0, at), value)
  }
  return values
}

/** The `total=` microseconds of a PSI file's `some` and `full` lines. */
function pressureTotals(
  text: string
): ReadonlyArray<readonly [string, number]> {
  return text.split("\n").flatMap((line) => {
    const scope = line.slice(0, line.indexOf(" "))
    const total = /\btotal=(\d+)/.exec(line)?.[1]
    return (scope === "some" || scope === "full") && total !== undefined
      ? [[scope, Number(total)] as const]
      : []
  })
}

/**
 * A /proc file, or null where it doesn't exist: PSI needs Linux 4.20 with it
 * enabled, and none of them exist off Linux.
 */
function readProc(name: string): Effect.Effect<string | null> {
  return Effect.tryPromise(() => readFile(`/proc/${name}`, "utf8")).pipe(
    Effect.orElseSucceed(() => null)
  )
}

function gauge(name: string, description: string, unit: string) {
  return Metric.gauge(name, { description, attributes: { unit } })
}

function counter(name: string, description: string, unit: string) {
  return Metric.counter(name, {
    description,
    attributes: { unit },
    incremental: true,
  })
}
