import { relayCreateDatabaseSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"
import { WORKLOAD_SLICE_LABEL } from "./docker-container-spec.js"

const SLICE = "kilnworkloads.slice"
const id = "a".repeat(40)

async function seeded() {
  const harness = await relayHarness()
  await harness.seedServer({ id, image: "example/server:latest" })
  fakeDocker.images.set("example/server:latest", {})
  const instance = await harness.docker.findInstance(id)
  if (!instance) throw new Error("Expected the seeded game server")
  return { harness, instance }
}

describe("moving workloads into the slice", () => {
  it("moves a stopped game server as it starts, keeping it the same server", async () => {
    const { harness, instance } = await seeded()
    harness.docker.allocations.setWorkloadLimit(SLICE, 1024 ** 3)

    await harness.lifecycle.runInstanceAction(instance, "start", [])

    const moved = fakeDocker.container(harness.resources.instanceContainer(id))!
    expect(moved.cgroupParent).toBe(SLICE)
    expect(moved.labels[WORKLOAD_SLICE_LABEL]).toBe(SLICE)
    expect(moved.labels["kiln.server.id"]).toBe(id)
    expect(moved.memoryBytes).toBe(512 * 1024 ** 2)
    expect(moved.state.running).toBe(true)
  })

  it("leaves a running game server alone when told to start", async () => {
    const { harness, instance } = await seeded()
    harness.docker.allocations.setWorkloadLimit(SLICE, 1024 ** 3)
    const container = fakeDocker.container(
      harness.resources.instanceContainer(id)
    )!
    container.state.running = true

    await harness.lifecycle.runInstanceAction(instance, "start", [])

    const after = fakeDocker.container(harness.resources.instanceContainer(id))!
    expect(after.id).toBe(container.id)
    expect(after.cgroupParent).toBe("")
    expect(after.state.running).toBe(true)
  })

  it("moves a running game server on an asked-for restart", async () => {
    const { harness, instance } = await seeded()
    harness.docker.allocations.setWorkloadLimit(SLICE, 1024 ** 3)
    fakeDocker.container(harness.resources.instanceContainer(id))!.state.running =
      true

    await harness.lifecycle.runInstanceAction(instance, "restart", [])

    const moved = fakeDocker.container(harness.resources.instanceContainer(id))!
    expect(moved.cgroupParent).toBe(SLICE)
  })

  it("leaves a game server where it is while no slice is confirmed", async () => {
    const { harness, instance } = await seeded()
    const before = fakeDocker.container(
      harness.resources.instanceContainer(id)
    )!.id

    await harness.lifecycle.runInstanceAction(instance, "start", [])

    const after = fakeDocker.container(harness.resources.instanceContainer(id))!
    expect(after.id).toBe(before)
    expect(after.cgroupParent).toBe("")
  })

  it("doesn't call a replaced database placed when it isn't", async () => {
    const harness = await relayHarness()
    const databaseId = "d".repeat(40)
    const allocations = harness.docker.allocations
    allocations.setWorkloadLimit(SLICE, 1024 ** 3)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id: databaseId,
        name: "Main database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    const name = `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
    expect(fakeDocker.container(name)!.labels[WORKLOAD_SLICE_LABEL]).toBe(SLICE)
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: 512 * 1024 ** 2 },
    })

    // A later start couldn't confirm the slice, then removing the limit
    // replaces the container.
    allocations.setWorkloadLimit(null, 1024 ** 3)
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: null },
    })

    const replaced = fakeDocker.container(name)!
    expect(replaced.cgroupParent).toBe("")
    expect(replaced.labels[WORKLOAD_SLICE_LABEL]).toBeUndefined()
  })
})
