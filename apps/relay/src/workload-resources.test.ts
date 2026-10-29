import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { RESOURCE_SAMPLE_INTERVAL_MS } from "./resource-samples.js"
import { fakeDocker } from "./test/docker.js"
import { WorkloadResources } from "./workload-resources.js"

const namespace = "kiln-test"
const appId = "a".repeat(40)
const databaseId = "d".repeat(40)
const gib = 1024 ** 3

afterEach(() => {
  vi.useRealTimers()
})

async function workloads() {
  const resources = new WorkloadResources(
    { resourceNamespace: namespace },
    new DockerEngine(await fakeDocker.listen())
  )
  onTestFinished(() => fakeDocker.reset())
  return resources
}

function appContainer(name: string, service: string, usedBytes: number) {
  fakeDocker.addContainer({
    labels: {
      "kiln.app.id": appId,
      "kiln.app.service": service,
      "kiln.relay.owner": namespace,
      "kiln.resource.kind": "app",
    },
    memoryBytes: gib,
    name,
    running: true,
  })
  fakeDocker.memoryUsage.set(name, usedBytes)
}

/**
 * Runs snapshot ticks, as the Relay's snapshot loop does, until the App and
 * each of its services keep `count` samples.
 */
async function sampleRounds(resources: WorkloadResources, count: number) {
  vi.useFakeTimers({ toFake: ["Date"] })
  for (let tick = 0; tick < 2_000; tick += 1) {
    const usage = resources.usage("app", appId)
    if (
      usage.history.length >= count &&
      usage.services.every((service) => service.history.length >= count)
    )
      return
    resources.tick()
    await new Promise((resolve) => setTimeout(resolve, 5))
    vi.setSystemTime(Date.now() + RESOURCE_SAMPLE_INTERVAL_MS / 3)
  }
  throw new Error("The App was never sampled")
}

const usedBytes = (
  usage: { resources: { memory: { usedBytes: number } } | null } | undefined
) => usage?.resources?.memory.usedBytes

describe("App and database usage", () => {
  it("keeps an App's usage, and each service's, over the same minutes", async () => {
    const resources = await workloads()
    // A deployment rolling out web keeps its old container beside the new.
    appContainer("web-old", "web", 100)
    appContainer("web-new", "web", 200)
    appContainer("worker", "worker", 50)

    await sampleRounds(resources, 3)

    const usage = resources.usage("app", appId)
    expect(usedBytes(usage)).toBe(350)
    expect(usage.services.map(({ service }) => service)).toEqual([
      "web",
      "worker",
    ])
    expect(usedBytes(usage.services[0])).toBe(300)
    expect(usedBytes(usage.services[1])).toBe(50)
    // Two web containers can't use more than the node has.
    expect(usage.resources?.memory.totalBytes).toBeLessThanOrEqual(
      3 * gib
    )
    expect(usage.services[0]?.history.map((sample) => sample.memory.usedBytes))
      .toContain(300)
    expect(
      usage.services[1]?.history.every(
        (sample) => sample.memory.usedBytes === 50
      )
    ).toBe(true)

    // The deployment finishes: the old container goes, and so does worker.
    fakeDocker.removeContainer("web-old")
    fakeDocker.removeContainer("worker")
    await sampleRounds(resources, usage.history.length + 3)
    const after = resources.usage("app", appId)
    expect(after.services.map(({ service }) => service)).toEqual(["web"])
    expect(usedBytes(after)).toBe(200)
    expect(usedBytes(after.services[0])).toBe(200)
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
    fakeDocker.memoryUsage.set("database", 64)
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
    fakeDocker.memoryUsage.set("other-database", 1_000)
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let tick = 0; tick < 2_000; tick += 1) {
      if (resources.usage("database", databaseId).history.length >= 2) break
      resources.tick()
      await new Promise((resolve) => setTimeout(resolve, 5))
      vi.setSystemTime(Date.now() + RESOURCE_SAMPLE_INTERVAL_MS / 3)
    }

    const usage = resources.usage("database", databaseId)
    expect(usedBytes(usage)).toBe(64)
    expect(usage.services).toEqual([])
    expect(usage.history.every((sample) => sample.memory.usedBytes === 64))
      .toBe(true)

    fakeDocker.container("database")!.state.running = false
    for (let tick = 0; tick < 2_000; tick += 1) {
      if (resources.usage("database", databaseId).resources === null) break
      resources.tick()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(resources.usage("database", databaseId).resources).toBeNull()
  })
})
