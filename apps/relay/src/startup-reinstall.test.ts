import {
  relayCreateDatabaseSchema,
  relayUpdateInstanceStartupSchema,
} from "@workspace/contracts"
import { totalmem } from "node:os"

import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  serverRecipe,
  type RelayHarness,
} from "./test/relay.js"

const id = "a".repeat(40)
const GIBIBYTE = 1024 ** 3

function serverContainer(harness: RelayHarness) {
  const container = fakeDocker.container(harness.resources.instanceContainer(id))
  if (!container) throw new Error("The server has no container")
  return container
}

const reconfigure = (harness: RelayHarness, input: unknown) =>
  harness.lifecycle.reconfigureInstance(
    id,
    relayUpdateInstanceStartupSchema.parse(input)
  )

describe("startup reinstall", () => {
  it("reinstalls the applied Brick, variables, and quota, ignoring stale client fields", async () => {
    const harness = await relayHarness()
    const created = await harness.createServer({
      id,
      start: true,
      variables: { version: "1.2.3" },
    })

    const reinstalled = await reconfigure(harness, {
      diskLimitBytes: 2 * GIBIBYTE,
      recipe: "https://example.com/other.yml",
      reinstall: true,
      start: false,
      variables: { version: "9.9.9" },
    })

    expect(reinstalled).toMatchObject({
      brickSource: created.brickSource,
      limits: { diskBytes: GIBIBYTE },
      variables: { version: "1.2.3" },
    })
    const container = serverContainer(harness)
    expect(container.image).toBe("registry.example.com/example/server:1.2.3")
    expect(container.state.running).toBe(true)
  })

  it("keeps a server's memory claimed while its container is replaced", async () => {
    const harness = await relayHarness()
    // Over half the node, so two such limits can't both fit.
    const most = Math.ceil((totalmem() * 0.6) / 1024 ** 2) * 1024 ** 2
    await harness.createServer({ id, limits: { memoryBytes: most } })
    const databaseId = "d".repeat(40)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id: databaseId,
        name: "Main",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    // Docker holds the new container's creation, once the old one is gone.
    const creation = fakeDocker.hold({ command: "create" })
    const reconfiguring = reconfigure(harness, { start: false, variables: {} })
    await creation.reached

    await expect(
      harness.databases.setLimits({ databaseId, limits: { memoryBytes: most } })
    ).rejects.toThrow(/Memory limit exceeds/u)

    creation.release()
    await reconfiguring
    expect(serverContainer(harness).memoryBytes).toBe(most)
  })

  it("keeps a server's larger memory claimed until its old container is gone", async () => {
    const harness = await relayHarness()
    const MIB = 1024 ** 2
    const most = Math.ceil((totalmem() * 0.6) / MIB) * MIB
    await harness.createServer({ id, limits: { memoryBytes: most } })
    const databaseId = "d".repeat(40)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id: databaseId,
        name: "Main",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    // Lowering the limit, with Docker holding the old container's removal.
    const removal = fakeDocker.hold({ command: "rm" })
    const reconfiguring = reconfigure(harness, {
      limits: { memoryBytes: 256 * MIB },
      start: false,
      variables: {},
    })
    await removal.reached

    await expect(
      harness.databases.setLimits({ databaseId, limits: { memoryBytes: most } })
    ).rejects.toThrow(/Memory limit exceeds/u)

    removal.release()
    await reconfiguring
    expect(serverContainer(harness).memoryBytes).toBe(256 * MIB)
  })

  it("keeps a server's limits across startup changes until they change", async () => {
    const harness = await relayHarness()
    await harness.createServer({
      id,
      limits: { cpuMillis: 1500, memoryBytes: null },
    })
    expect(serverContainer(harness)).toMatchObject({
      memoryBytes: 0,
      nanoCpus: 1.5e9,
    })

    const kept = await reconfigure(harness, {
      start: false,
      variables: { version: "2.0.0" },
    })
    expect(kept.limits).toEqual({
      cpuMillis: 1500,
      diskBytes: GIBIBYTE,
      memoryBytes: null,
    })

    const changed = await reconfigure(harness, {
      limits: { cpuMillis: null, diskBytes: null, memoryBytes: 512 * 1024 ** 2 },
      start: false,
      variables: { version: "2.0.0" },
    })
    expect(changed.limits).toEqual({
      cpuMillis: null,
      diskBytes: null,
      memoryBytes: 512 * 1024 ** 2,
    })
    expect(serverContainer(harness)).toMatchObject({
      memoryBytes: 512 * 1024 ** 2,
      nanoCpus: 0,
    })
    // A Relay that restarts finds the same limits on the container.
    const [rediscovered] = await harness.docker.inspectInstances()
    expect(rediscovered?.limits).toEqual(changed.limits)
  })

  it("keeps a stopped server stopped even when the client asks to start", async () => {
    const harness = await relayHarness()
    await harness.createServer({ id, start: false })

    await reconfigure(harness, { reinstall: true, start: true })

    expect(serverContainer(harness).state.running).toBe(false)
  })

  it("applies client startup changes when not reinstalling", async () => {
    const harness = await relayHarness()
    await harness.createServer({ id, start: false })
    const next = serverRecipe({
      metadata: { ...serverRecipe().metadata, id: "example-next" },
      runtime: {
        ...serverRecipe().runtime,
        image: "registry.example.com/next/server:{{ variables.version }}",
      },
    })

    const updated = await reconfigure(harness, {
      recipe: await harness.publishRecipe(next),
      start: true,
      variables: { version: "2.0.0" },
    })

    expect(updated).toMatchObject({
      brickId: "example-next",
      variables: { version: "2.0.0" },
    })
    const container = serverContainer(harness)
    expect(container.image).toBe("registry.example.com/next/server:2.0.0")
    expect(container.state.running).toBe(true)
  })

  it("keeps the existing server when the replacement image cannot be pulled", async () => {
    const harness = await relayHarness()
    await harness.createServer({ id, start: true })
    const before = serverContainer(harness)
    fakeDocker.unreachableImages.add("registry.example.com/example/server:1.2.3")

    await expect(
      reconfigure(harness, { reinstall: true })
    ).rejects.toThrow("registry timeout")

    expect(serverContainer(harness)).toBe(before)
    expect(before.state.running).toBe(true)
  })
})

describe("startup database connections", () => {
  it.each([
    { reinstall: false, unavailable: false },
    { reinstall: true, unavailable: false },
    { reinstall: false, unavailable: true },
    { reinstall: true, unavailable: true },
  ])(
    "restores connections without failing the replacement (reinstall=$reinstall, unavailable=$unavailable)",
    async ({ reinstall, unavailable }) => {
      const harness = await relayHarness()
      harness.config.nodeId = "r".repeat(43)
      const databaseId = "b".repeat(40)
      await harness.createServer({ id, start: true })
      if (!unavailable) {
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
      }
      await harness.databaseConnections.set(id, databaseId, true)

      const replaced = await reconfigure(
        harness,
        reinstall ? { reinstall: true } : { start: true, variables: {} }
      )

      const container = serverContainer(harness)
      expect(container.state.running).toBe(true)
      expect(container.labels).toMatchObject({
        [`kiln.instance.databases.${databaseId}`]: harness.config.nodeId,
        "kiln.instance.databases.version": "1",
      })
      expect(
        container.networks.has(`kiln-test-kiln-db-${databaseId}-network`)
      ).toBe(!unavailable)
      expect(replaced.databaseConnectionWarnings ?? []).toHaveLength(
        unavailable ? 1 : 0
      )
    }
  )
})
