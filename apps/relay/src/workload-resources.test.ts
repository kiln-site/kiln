import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { RESOURCE_SAMPLE_INTERVAL_MS } from "./resource-samples.js"
import { fakeDocker, type FakeContainerUsage } from "./test/docker.js"
import { WorkloadResources } from "./workload-resources.js"

const namespace = "kiln-test"
const appId = "a".repeat(40)
const databaseId = "d".repeat(40)
const gib = 1024 ** 3

afterEach(() => {
  vi.useRealTimers()
})

// Only time is faked; Docker's socket stays real I/O, so each step yields to
// it before the clock moves on.
async function workloads() {
  const resources = new WorkloadResources(
    { resourceNamespace: namespace },
    new DockerEngine(await fakeDocker.listen())
  )
  onTestFinished(() => fakeDocker.reset())
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
  return resources
}

function appContainer(
  name: string,
  service: string,
  usage: FakeContainerUsage,
  nanoCpus = 0
) {
  fakeDocker.addContainer({
    labels: {
      "kiln.app.id": appId,
      "kiln.app.service": service,
      "kiln.relay.owner": namespace,
      "kiln.resource.kind": "app",
    },
    memoryBytes: gib,
    nanoCpus,
    name,
    running: true,
  })
  fakeDocker.usage.set(name, usage)
}

/**
 * Runs snapshot ticks a third of a sample interval apart, as the Relay's
 * snapshot loop does, until `done` holds.
 */
async function sampleUntil(resources: WorkloadResources, done: () => boolean) {
  for (let tick = 0; tick < 2_000; tick += 1) {
    if (done()) return
    resources.tick()
    for (let turn = 0; turn < 5; turn += 1) await yieldToEventLoop()
    await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS / 3)
  }
  throw new Error("The resource was never sampled")
}

// Until the App, and each of its services, keep `count` samples.
function appSampled(resources: WorkloadResources, count: number) {
  return () => {
    const usage = resources.usage("app", appId)
    return (
      usage.history.length >= count &&
      usage.services.every(
        ({ service }) => serviceHistory(resources, service).length >= count
      )
    )
  }
}

function serviceHistory(resources: WorkloadResources, service: string) {
  return (
    resources
      .usage("app", appId, { service })
      .services.find((candidate) => candidate.service === service)?.history ??
    []
  )
}

const usedBytes = (
  usage: { resources: { memory: { usedBytes: number } } | null } | undefined
) => usage?.resources?.memory.usedBytes

describe("App and database usage", () => {
  it("keeps an App's usage, and each service's, over the same minutes", async () => {
    const resources = await workloads()
    // A deployment rolling out web keeps its old container beside the new.
    appContainer("web-old", "web", { memoryBytes: 100 })
    appContainer("web-new", "web", { memoryBytes: 200 })
    appContainer("worker", "worker", { memoryBytes: 50 })

    await sampleUntil(resources, appSampled(resources, 3))

    const usage = resources.usage("app", appId)
    expect(usedBytes(usage)).toBe(350)
    expect(usage.services.map(({ service }) => service)).toEqual([
      "web",
      "worker",
    ])
    expect(usedBytes(usage.services[0])).toBe(300)
    expect(usedBytes(usage.services[1])).toBe(50)
    // Two web containers can't use more than the node has.
    expect(usage.resources?.memory.totalBytes).toBeLessThanOrEqual(3 * gib)
    // A read carries one history: the App's, or one service's.
    expect(usage.services.every(({ history }) => history.length === 0)).toBe(
      true
    )
    expect(
      serviceHistory(resources, "web").map(
        (sample) => sample.memory.usedBytes
      )
    ).toContain(300)
    expect(
      serviceHistory(resources, "worker").every(
        (sample) => sample.memory.usedBytes === 50
      )
    ).toBe(true)
    const withWorker = resources.usage("app", appId, { service: "worker" })
    expect(withWorker.history).toEqual([])

    // The deployment finishes: the old container goes, and so does worker.
    fakeDocker.removeContainer("web-old")
    fakeDocker.removeContainer("worker")
    await sampleUntil(resources, appSampled(resources, usage.history.length + 3))
    const after = resources.usage("app", appId)
    expect(after.services.map(({ service }) => service)).toEqual(["web"])
    expect(usedBytes(after)).toBe(200)
    expect(usedBytes(after.services[0])).toBe(200)
  })

  it("reads CPU against a container's limit, and traffic from a new container afresh", async () => {
    const resources = await workloads()
    // One and a half cores' worth, under a two-core limit, on four cores.
    appContainer(
      "web",
      "web",
      { cpuPercent: 150, onlineCpus: 4, receivedBytes: 1_000, sentBytes: 500 },
      2_000_000_000
    )
    await sampleUntil(
      resources,
      () => resources.usage("app", appId).resources !== null
    )
    expect(resources.usage("app", appId).resources?.cpu).toEqual({
      capacityPercent: 200,
      percent: 150,
    })

    // Traffic since the last sample, per second.
    fakeDocker.usage.set("web", {
      cpuPercent: 150,
      onlineCpus: 4,
      receivedBytes: 4_000,
      sentBytes: 500,
    })
    await sampleUntil(
      resources,
      () =>
        (resources.usage("app", appId).resources?.network
          ?.receivedBytesPerSecond ?? 0) > 0
    )
    expect(
      resources.usage("app", appId).resources?.network?.sentBytesPerSecond
    ).toBe(0)

    // A redeploy replaces the container, whose counters start again.
    fakeDocker.removeContainer("web")
    appContainer("web-next", "web", { receivedBytes: 10, sentBytes: 10 })
    await sampleUntil(
      resources,
      () =>
        resources.usage("app", appId).resources?.network?.receivedBytes === 10
    )
    expect(resources.usage("app", appId).resources?.network).toMatchObject({
      receivedBytes: 10,
      receivedBytesPerSecond: 0,
      sentBytesPerSecond: 0,
    })
  })

  it("keeps a database's usage, and nothing of a stopped one", async () => {
    const resources = await workloads()
    fakeDocker.addContainer({
      labels: {
        "kiln.database.id": databaseId,
        "kiln.relay.owner": namespace,
        "kiln.resource.kind": "database",
      },
      memoryBytes: gib,
      name: "database",
      running: true,
    })
    fakeDocker.usage.set("database", { memoryBytes: 64 })
    // Another Relay's database, which this one leaves alone.
    fakeDocker.addContainer({
      labels: {
        "kiln.database.id": databaseId,
        "kiln.relay.owner": "kiln-other",
        "kiln.resource.kind": "database",
      },
      memoryBytes: gib,
      name: "other-database",
      running: true,
    })
    fakeDocker.usage.set("other-database", { memoryBytes: 1_000 })
    await sampleUntil(
      resources,
      () => resources.usage("database", databaseId).history.length >= 2
    )

    const usage = resources.usage("database", databaseId)
    expect(usedBytes(usage)).toBe(64)
    expect(usage.services).toEqual([])
    expect(
      usage.history.every((sample) => sample.memory.usedBytes === 64)
    ).toBe(true)

    fakeDocker.container("database")!.state.running = false
    await sampleUntil(
      resources,
      () => resources.usage("database", databaseId).resources === null
    )
    expect(resources.usage("database", databaseId).resources).toBeNull()
  })
})
