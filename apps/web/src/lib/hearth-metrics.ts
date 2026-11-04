import { Effect, Fiber, Metric } from "effect"

import { forkAppWorker } from "@/effect/runtime"

/**
 * What Hearth's own process spends. Read from the process, so it reports
 * however Hearth was deployed and whether or not a Relay shares its host. A
 * Relay on its host also reports the container, as `hearth` in
 * `relay.container.*`, which is where the database and cache report.
 */
const memoryGauge = (name: string, description: string) =>
  Metric.gauge(name, {
    description: `${description}, in bytes`,
    attributes: { unit: "By" },
  })

const rss = memoryGauge("hearth.memory.rss", "Hearth process resident set")
const heapUsed = memoryGauge("hearth.memory.heap_used", "Hearth V8 heap in use")
const external = memoryGauge(
  "hearth.memory.external",
  "Hearth memory outside V8"
)

const cpuTime = Metric.counter("hearth.cpu.time", {
  description: "CPU time Hearth's process used; its rate is cores in use",
  attributes: { unit: "s" },
  incremental: true,
})

const sampleInterval = "15 seconds"

declare global {
  var kilnHearthMetricsWorker: Fiber.Fiber<void> | undefined
}

/** Records Hearth's memory and CPU every fifteen seconds. */
export function startHearthMetrics() {
  let cpu = process.cpuUsage()
  globalThis.kilnHearthMetricsWorker ??= forkAppWorker(
    Effect.suspend(() => {
      const memory = process.memoryUsage()
      const previous = cpu
      cpu = process.cpuUsage()
      const spent = cpu.user - previous.user + cpu.system - previous.system
      return Effect.all(
        [
          Metric.update(rss, memory.rss),
          Metric.update(heapUsed, memory.heapUsed),
          Metric.update(external, memory.external),
          Metric.update(cpuTime, spent / 1e6),
        ],
        { discard: true }
      )
    }).pipe(Effect.andThen(Effect.sleep(sampleInterval)), Effect.forever)
  )
}

/** Runtime disposal does not interrupt forked workers, so stop it first. */
export function stopHearthMetrics(): Promise<void> {
  const worker = globalThis.kilnHearthMetricsWorker
  globalThis.kilnHearthMetricsWorker = undefined
  return worker ? Effect.runPromise(Fiber.interrupt(worker)) : Promise.resolve()
}

// In development, a reloaded module starts a worker running its new code.
if (import.meta.hot) import.meta.hot.dispose(() => stopHearthMetrics())
