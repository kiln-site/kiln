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
    await expect(manager.reconcile(instanceId, "server")).rejects.toThrow(
      "network is unavailable"
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
    await expect(manager.reconcile(instanceId, "server")).rejects.toThrow(
      "Docker unavailable"
    )
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
})
