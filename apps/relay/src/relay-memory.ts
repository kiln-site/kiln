import { readFile } from "node:fs/promises"

import type { RelayProcessMemory } from "@workspace/contracts"
import { Effect, Metric, Predicate } from "effect"

import { forkRelayEffect } from "./effect/runtime.js"

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

const memoryGauges = {
  rss: memoryGauge("relay.memory.rss", "Relay process resident set"),
  heapUsed: memoryGauge("relay.memory.heap_used", "Relay V8 heap in use"),
  external: memoryGauge("relay.memory.external", "Relay memory outside V8"),
  containerUsed: memoryGauge(
    "relay.memory.container.used",
    "Relay container memory, including page cache"
  ),
  containerAnon: memoryGauge(
    "relay.memory.container.anon",
    "Relay container anonymous memory"
  ),
  containerFile: memoryGauge(
    "relay.memory.container.file",
    "Relay container page cache"
  ),
}

/**
 * Samples the Relay's own memory for the 2-second node snapshot. Process
 * numbers are free to read; the cgroup files are cached for a few seconds and
 * skipped for good once `memory.current` is known not to exist.
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

/** Records Relay memory gauges at most once a minute. */
export function reportRelayMemoryMetrics(
  memory: RelayProcessMemory | undefined
): void {
  const now = Date.now()
  if (!memory || now - metricsReportedAt < metricsIntervalMs) return
  metricsReportedAt = now
  const readings = [
    [memoryGauges.rss, memory.process.rssBytes],
    [memoryGauges.heapUsed, memory.process.heapUsedBytes],
    [memoryGauges.external, memory.process.externalBytes],
    [memoryGauges.containerUsed, memory.container?.usedBytes],
    [memoryGauges.containerAnon, memory.container?.anonBytes],
    [memoryGauges.containerFile, memory.container?.fileBytes],
  ] as const
  forkRelayEffect(
    "relay.memory.metrics",
    Effect.forEach(
      readings,
      ([gauge, value]) =>
        value == null ? Effect.void : Metric.update(gauge, value),
      { discard: true }
    )
  )
}

function memoryGauge(name: string, description: string) {
  return Metric.gauge(name, {
    description: `${description}, in bytes`,
    attributes: { unit: "By" },
  })
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
  const value = Effect.runPromise(readContainerMemory())
  containerSample = { sampledAt: now, value }
  return value
}

const readContainerMemory = Effect.fnUntraced(function* () {
  const [current, max, stat] = yield* Effect.all(
    [
      readCgroupFile("memory.current").pipe(
        Effect.catchIf(isMissingFile, () =>
          // No memory.current means cgroup v1, a host process, or a host
          // cgroup namespace (the root cgroup has no memory.current); none of
          // these change while the Relay runs.
          Effect.sync(() => {
            cgroupUnavailable = true
            return null
          })
        ),
        // Other failures, such as EMFILE during heavy file activity, are
        // retried once the cached sample expires.
        Effect.orElseSucceed(() => null)
      ),
      readCgroupFile("memory.max").pipe(Effect.orElseSucceed(() => null)),
      readCgroupFile("memory.stat").pipe(Effect.orElseSucceed(() => null)),
    ],
    { concurrency: "unbounded" }
  )
  const usedBytes = current === null ? null : byteCount(current)
  if (usedBytes === null) return null
  const values = stat === null ? null : memoryStatValues(stat)
  return {
    usedBytes,
    limitBytes: max === null ? null : byteCount(max),
    anonBytes: values?.anon ?? null,
    fileBytes: values?.file ?? null,
    activeFileBytes: values?.active_file ?? null,
    inactiveFileBytes: values?.inactive_file ?? null,
    kernelBytes: values?.kernel ?? null,
  } satisfies ContainerMemory
})

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

function isMissingFile(cause: unknown): boolean {
  return (
    Predicate.hasProperty(cause, "code") &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  )
}

function readCgroupFile(name: string): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () => readFile(`${cgroupDirectory}/${name}`, "utf8"),
    catch: (cause) => cause,
  })
}
