import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const commandMock = vi.hoisted(() => vi.fn())
vi.mock("./command.js", () => ({ command: commandMock }))

import { loadConfig } from "./config.js"
import {
  databaseConnectionLabels,
  decodeDatabaseConnectionLabels,
  DatabaseConnections,
} from "./database-connections.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"

const instanceId = "a".repeat(40)
const databaseId = "b".repeat(40)
const relayId = "relay-with_hyphens".padEnd(43, "x")
const remoteRelayId = "r".repeat(43)
const network = "owned-database-network"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.clearAllMocks()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-database-connections-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "relay.sqlite")
  const runtime = ManagedRuntime.make(makeRelayStateLayer(path))
  cleanup.push(() => runtime.dispose())
  const state = await runtime.runPromise(RelayStateStore)
  const config = loadConfig({
    NODE_ENV: "test",
    KILN_RELAY_RESOURCE_NAMESPACE: "connection-test",
  })
  config.nodeId = relayId
  const manager = new DatabaseConnections(config, state)
  const attached = new Set<string>()
  commandMock.mockImplementation(
    async (_executable: string, args: Array<string>) => {
      if (args[0] === "network" && args[1] === "ls")
        return { stdout: "network-id", stderr: "" }
      if (args[0] === "network" && args[1] === "inspect")
        return {
          stdout: JSON.stringify([
            {
              Name: network,
              Labels: {
                "kiln.relay.owner": "connection-test",
                "kiln.database.id": databaseId,
                "kiln.database.network": network,
              },
            },
            {
              Name: "foreign-network",
              Labels: {
                "kiln.relay.owner": "another-relay",
                "kiln.database.id": "c".repeat(40),
                "kiln.database.network": "foreign-network",
              },
            },
          ]),
          stderr: "",
        }
      if (args[0] === "inspect")
        return {
          stdout: JSON.stringify(
            Object.fromEntries([...attached].map((name) => [name, {}]))
          ),
          stderr: "",
        }
      if (args[0] === "network" && args[1] === "connect") attached.add(args[2]!)
      else if (args[0] === "network" && args[1] === "disconnect")
        attached.delete(args[2]!)
      else throw new Error(`Unexpected Docker command: ${args.join(" ")}`)
      return { stdout: "", stderr: "" }
    }
  )
  return { manager, state, attached, path }
}

describe("database connection recovery", () => {
  it("validates full IDs and round-trips hyphens without JSON", () => {
    const references = [{ databaseId, relayId }]
    expect(
      decodeDatabaseConnectionLabels(databaseConnectionLabels(references))
    ).toEqual({ connections: references, warnings: [] })
    expect(databaseConnectionLabels([])).toEqual({
      "kiln.instance.databases.version": "1",
    })
    expect(
      decodeDatabaseConnectionLabels({ "kiln.instance.databases.version": "2" })
        .warnings
    ).toHaveLength(1)
    expect(
      decodeDatabaseConnectionLabels({
        "kiln.instance.databases.version": "1",
        "kiln.instance.databases.bad": relayId,
      }).warnings
    ).toHaveLength(1)
  })

  it("imports existing attachments once and keeps disconnects across reopening SQLite", async () => {
    const { manager, state, path } = await setup()
    const snapshot = {
      instanceId,
      service: "server",
      labels: {},
      networks: [network],
    }
    await manager.initialize([snapshot])
    expect(
      await Effect.runPromise(state.listInstanceDatabaseConnections(instanceId))
    ).toEqual([{ instanceId, databaseId, relayId }])
    await manager.set(instanceId, databaseId, false)
    const reopened = ManagedRuntime.make(makeRelayStateLayer(path))
    cleanup.push(() => reopened.dispose())
    const reopenedState = await reopened.runPromise(RelayStateStore)
    const recovered = new DatabaseConnections(manager.config, reopenedState)
    await recovered.initialize([
      {
        ...snapshot,
        labels: databaseConnectionLabels([{ databaseId, relayId }]),
      },
    ])
    expect(await recovered.labels(instanceId)).toEqual(
      databaseConnectionLabels([])
    )
  })

  it("uses live local memberships over stale labels and retains remote recovery references", async () => {
    const { manager } = await setup()
    const remote = { databaseId: "d".repeat(40), relayId: remoteRelayId }
    await manager.initialize([
      {
        instanceId,
        service: "server",
        networks: [],
        labels: databaseConnectionLabels([{ databaseId, relayId }, remote]),
      },
    ])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([remote])
    )
    await manager.reconcile(instanceId, "server")
    expect(
      commandMock.mock.calls.some(([, args]) => args[1] === "connect")
    ).toBe(false)
  })

  it("recovers a label reference when its database network is temporarily absent", async () => {
    const { manager } = await setup()
    const missing = { databaseId: "e".repeat(40), relayId }
    await manager.initialize([
      {
        instanceId,
        service: "server",
        networks: [],
        labels: databaseConnectionLabels([missing]),
      },
    ])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([missing])
    )
    await manager.set(instanceId, databaseId, true)
    expect(await manager.reconcile(instanceId, "server")).toEqual([
      {
        databaseId: missing.databaseId,
        message: expect.stringContaining("network is unavailable"),
      },
    ])
    expect(commandMock).toHaveBeenCalledWith("docker", [
      "network",
      "connect",
      network,
      "server",
    ])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([missing, { databaseId, relayId }])
    )
  })

  it("reconnects replacement containers, removes stale attachments, and leaves unrelated networks alone", async () => {
    const { manager, attached } = await setup()
    await manager.initialize([])
    attached.add("foreign-network")
    await manager.set(instanceId, databaseId, true)
    await manager.reconcile(instanceId, "replacement")
    expect(attached).toEqual(new Set(["foreign-network", network]))
    commandMock.mockClear()
    await manager.reconcile(instanceId, "replacement")
    expect(
      commandMock.mock.calls.some(([, args]) => args[1] === "connect")
    ).toBe(false)
    await manager.set(instanceId, databaseId, false)
    await manager.reconcile(instanceId, "replacement")
    expect(attached).toEqual(new Set(["foreign-network"]))
  })

  it("retains desired connections after Docker fails and cleans up deleted servers and databases", async () => {
    const { manager, state } = await setup()
    await manager.initialize([])
    await manager.set(instanceId, databaseId, true)
    const normal = commandMock.getMockImplementation()!
    commandMock.mockImplementation(async (...args) => {
      if (args[1][1] === "connect") throw new Error("Docker unavailable")
      return normal(...args)
    })
    expect(await manager.reconcile(instanceId, "server")).toEqual([
      { databaseId, message: expect.stringContaining("Docker unavailable") },
    ])
    commandMock.mockImplementation(normal)
    expect(await manager.reconcile(instanceId, "server")).toEqual([])
    expect(manager.issues(instanceId)).toEqual([])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([{ databaseId, relayId }])
    )
    await manager.set("f".repeat(40), databaseId, true)
    await manager.forgetInstance(instanceId)
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([])
    )
    expect(
      await Effect.runPromise(
        state.listInstanceDatabaseConnections("f".repeat(40))
      )
    ).toHaveLength(1)
    await manager.forgetDatabase(databaseId)
    expect(await manager.labels("f".repeat(40))).toEqual(
      databaseConnectionLabels([])
    )
  })
  it("isolates discovery races and failed attachments from healthy connections", async () => {
    const { manager, attached } = await setup()
    const healthyId = "c".repeat(40)
    await manager.set(instanceId, databaseId, true)
    await manager.set(instanceId, healthyId, true)
    const normal = commandMock.getMockImplementation()!
    commandMock.mockImplementation(async (...args) => {
      const commandArgs = args[1]
      if (commandArgs[0] === "network" && commandArgs[1] === "ls")
        return { stdout: "network-id healthy-id vanished-id", stderr: "" }
      if (commandArgs[0] === "network" && commandArgs[1] === "inspect") {
        if (commandArgs[2] === "vanished-id")
          throw new Error("Network not found")
        if (commandArgs[2] === "healthy-id")
          return {
            stdout: JSON.stringify([
              {
                Name: "healthy",
                Labels: {
                  "kiln.relay.owner": "connection-test",
                  "kiln.database.id": healthyId,
                  "kiln.database.network": "healthy",
                },
              },
            ]),
            stderr: "",
          }
      }
      if (commandArgs[1] === "connect" && commandArgs[2] === network)
        throw new Error("Network disappeared before connect")
      return normal(...args)
    })
    const issues = await manager.reconcile(instanceId, "server")
    expect(issues).toHaveLength(2)
    expect(issues.some((issue) => issue.databaseId === databaseId)).toBe(true)
    expect(attached.has("healthy")).toBe(true)
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([
        { databaseId, relayId },
        { databaseId: healthyId, relayId },
      ])
    )
  })

  it("reports discovery failure without rejecting server startup", async () => {
    const { manager } = await setup()
    await manager.set(instanceId, databaseId, true)
    commandMock.mockRejectedValue(new Error("Docker unavailable"))
    expect(await manager.reconcile(instanceId, "server")).toEqual([
      {
        databaseId: null,
        message: expect.stringContaining("Docker unavailable"),
      },
    ])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([{ databaseId, relayId }])
    )
  })

  it("recognizes only owned database network names even when the network no longer exists", async () => {
    const { manager } = await setup()
    expect(
      manager.isDatabaseNetwork(`connection-test-kiln-db-${databaseId}-network`)
    ).toBe(true)
    expect(
      manager.isDatabaseNetwork(`foreign-kiln-db-${databaseId}-network`)
    ).toBe(false)
    expect(manager.isDatabaseNetwork("connection-test-kiln-minecraft")).toBe(
      false
    )
    expect(
      manager.isDatabaseNetwork("connection-test-kiln-db-invalid-network")
    ).toBe(false)
  })
  it.each(["ls", "inspect"])(
    "imports live and labeled references when network %s fails",
    async (step) => {
      const { manager, state } = await setup()
      const ownedNetwork = `connection-test-kiln-db-${databaseId}-network`
      const missing = { databaseId: "e".repeat(40), relayId }
      const normal = commandMock.getMockImplementation()!
      commandMock.mockImplementation(async (...args) => {
        if (args[1][0] === "network" && args[1][1] === step)
          throw new Error("Network disappeared")
        return normal(...args)
      })
      const snapshot = {
        instanceId,
        service: "server",
        networks: [ownedNetwork, `foreign-kiln-db-${"f".repeat(40)}-network`],
        labels: databaseConnectionLabels([missing]),
      }
      await manager.initialize([snapshot])
      expect(await manager.labels(instanceId)).toEqual(
        databaseConnectionLabels([{ databaseId, relayId }, missing])
      )
      expect(manager.saved(instanceId)).toHaveLength(2)
      expect(
        await Effect.runPromise(
          state.getMetadata("database_connections_recovered")
        )
      ).toBeTruthy()
      await manager.set(instanceId, databaseId, false)
      await manager.initialize([snapshot])
      expect(await manager.labels(instanceId)).toEqual(
        databaseConnectionLabels([missing])
      )
    }
  )

  it("removes a missing database reference without attaching it, including remote references", async () => {
    const { manager } = await setup()
    const remote = { databaseId: "e".repeat(40), relayId: remoteRelayId }
    await manager.initialize([
      {
        instanceId,
        service: "server",
        networks: [],
        labels: databaseConnectionLabels([remote]),
      },
    ])
    await manager.set(instanceId, remote.databaseId, false, relayId)
    expect(manager.saved(instanceId)).toEqual([expect.objectContaining(remote)])
    await manager.set(instanceId, remote.databaseId, false, remoteRelayId)
    expect(await manager.reconcile(instanceId, "server")).toEqual([])
    expect(manager.saved(instanceId)).toEqual([])
    expect(await manager.labels(instanceId)).toEqual(
      databaseConnectionLabels([])
    )
    expect(
      commandMock.mock.calls.some(([, args]) => args[1] === "connect")
    ).toBe(false)
  })
})
