import { readFile } from "node:fs/promises"

import * as Sentry from "@sentry/node"
import type { RelayProcessMemory } from "@workspace/contracts"

type ContainerMemory = NonNullable<RelayProcessMemory["container"]>

// In a cgroup v2 container with its own cgroup namespace (Docker's default),
// this is the Relay container's own cgroup.
const cgroupDirectory = "/sys/fs/cgroup"
const containerSampleTtlMs = 5_000
const metricsIntervalMs = 60_000

let containerSample: {
  readonly sampledAt: number
  readonly value: Promise<ContainerMemory | null>
} | null = null
let cgroupUnavailable = false
let metricsReportedAt = 0

/**
 * Samples the Relay's own memory for the 2-second node snapshot. Process
 * numbers are free to read; the cgroup files are cached for a few seconds and
 * skipped for good once the Relay is known not to run in a cgroup v2 container.
 */
export async function relayProcessMemory(): Promise<RelayProcessMemory> {
  const usage = process.memoryUsage()
  return {
    process: {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    },
    container: await containerMemory(),
  }
}

/** Sends Relay memory gauges to Sentry at most once a minute. */
export function reportRelayMemoryMetrics(
  memory: RelayProcessMemory | undefined
): void {
  const now = Date.now()
  if (!memory || now - metricsReportedAt < metricsIntervalMs) return
  metricsReportedAt = now
  const gauge = (name: string, value: number | null | undefined) => {
    if (value != null) Sentry.metrics.gauge(name, value, { unit: "byte" })
  }
  gauge("relay.memory.rss", memory.process.rssBytes)
  gauge("relay.memory.heap_used", memory.process.heapUsedBytes)
  gauge("relay.memory.external", memory.process.externalBytes)
  gauge("relay.memory.container.used", memory.container?.usedBytes)
  gauge("relay.memory.container.anon", memory.container?.anonBytes)
  gauge("relay.memory.container.file", memory.container?.fileBytes)
}

function containerMemory(): Promise<ContainerMemory | null> {
  if (cgroupUnavailable) return Promise.resolve(null)
  const now = Date.now()
  if (
    containerSample &&
    now - containerSample.sampledAt < containerSampleTtlMs
  ) {
    return containerSample.value
  }
  const value = readContainerMemory()
  containerSample = { sampledAt: now, value }
  return value
}

async function readContainerMemory(): Promise<ContainerMemory | null> {
  const [current, max, stat] = await Promise.all([
    readCgroupFile("memory.current"),
    readCgroupFile("memory.max"),
    readCgroupFile("memory.stat"),
  ])
  const usedBytes = current === null ? null : byteCount(current)
  if (usedBytes === null) {
    // cgroup v1, a host process, or a cgroup namespace without memory
    // accounting. None of these change while the Relay runs.
    cgroupUnavailable = true
    containerSample = null
    return null
  }
  const values = stat === null ? null : memoryStatValues(stat)
  return {
    usedBytes,
    limitBytes: max === null ? null : byteCount(max),
    anonBytes: values?.anon ?? null,
    fileBytes: values?.file ?? null,
    activeFileBytes: values?.active_file ?? null,
    inactiveFileBytes: values?.inactive_file ?? null,
    kernelBytes: values?.kernel ?? null,
  }
}

const memoryStatKeys = new Set([
  "anon",
  "file",
  "active_file",
  "inactive_file",
  "kernel",
])

function memoryStatValues(stat: string): Partial<Record<string, number>> {
  const values: Partial<Record<string, number>> = {}
  for (const line of stat.split("\n")) {
    const separator = line.indexOf(" ")
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (!memoryStatKeys.has(key)) continue
    const value = byteCount(line.slice(separator + 1))
    if (value !== null) values[key] = value
  }
  return values
}

/** `memory.max` reads `max` when unlimited, which maps to null. */
function byteCount(value: string): number | null {
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function readCgroupFile(name: string): Promise<string | null> {
  return readFile(`${cgroupDirectory}/${name}`, "utf8").catch(() => null)
}
