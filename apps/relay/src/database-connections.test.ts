import { join } from "node:path"

import { Effect, ManagedRuntime } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DatabaseConnections } from "./database-connections.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const instanceId = "a".repeat(40)
const databaseId = "b".repeat(40)
const healthyId = "c".repeat(40)
const relayId = "relay-with_hyphens".padEnd(43, "x")
const remoteRelayId = "r".repeat(43)
const network = "owned-database-network"

type Reference = { databaseId: string; relayId: string }

/** The container label format other Relay versions read and write. */
function connectionLabels(references: ReadonlyArray<Reference>) {
  return {
    "kiln.instance.databases.version": "1",
    ...Object.fromEntries(
      references.map((reference) => [
        `kiln.instance.databases.${reference.databaseId}`,
        reference.relayId,
      ])
    ),
  }
}

function databaseNetwork(name: string, id: string, owner = TEST_NAMESPACE) {
  return fakeDocker.addNetwork({
    internal: true,
    labels: {
      "kiln.database.id": id,
      "kiln.database.network": name,
      "kiln.relay.owner": owner,
      "kiln.resource.kind": "database",
    },
    name,
  })
}

async function setup() {
  const harness = await relayHarness()
  harness.config.nodeId = relayId
  databaseNetwork(network, databaseId)
  databaseNetwork("foreign-network", "f".repeat(40), "another-relay")
  const server = fakeDocker.addContainer({ name: "server", running: true })
  return { harness, manager: harness.databaseConnections, server }
}

const snapshot = (
  input: Partial<{ labels: Record<string, string>; networks: Array<string> }>
) => ({
  instanceId,
  labels: input.labels ?? {},
  networks: input.networks ?? [],
  service: "server",
})

describe("database connection recovery", () => {
  it("writes the versioned label format and recovers it on another Relay state", async () => {
    const { harness, manager } = await setup()
    const remote = { databaseId: "d".repeat(40), relayId: remoteRelayId }
    await manager.set(instanceId, databaseId, true)
    await manager.set(instanceId, remote.databaseId, true, remoteRelayId)

    const labels = await manager.labels(instanceId)
    expect(labels).toEqual(
      connectionLabels([{ databaseId, relayId }, remote])
    )

    const other = await relayHarness()
    other.config.nodeId = "o".repeat(43)
    await other.databaseConnections.initialize([snapshot({ labels })])
    expect(await other.databaseConnections.labels(instanceId)).toEqual(labels)
    expect(harness.config.nodeId).toBe(relayId)
  })

  it("skips unsupported versions and malformed references", async () => {
    const { manager } = await setup()

    await manager.initialize([
      snapshot({
        labels: {
          "kiln.instance.databases.bad": relayId,
          [`kiln.instance.databases.${healthyId}`]: "not a relay id",
          "kiln.instance.databases.version": "1",
        },
      }),
    ])
    expect(await manager.labels(instanceId)).toEqual(connectionLabels([]))

    const second = await relayHarness()
    await second.databaseConnections.initialize([
      snapshot({
        labels: {
          [`kiln.instance.databases.${databaseId}`]: relayId,
          "kiln.instance.databases.version": "2",
        },
      }),
    ])
    expect(await second.databaseConnections.labels(instanceId)).toEqual(
      connectionLabels([])
    )
  })

  it("imports existing attachments once and keeps disconnects across reopening SQLite", async () => {
    const { harness, manager } = await setup()
    await manager.initialize([snapshot({ networks: [network] })])
    expect(
      await Effect.runPromise(harness.state.listInstanceDatabaseConnections(instanceId))
    ).toEqual([{ databaseId, instanceId, relayId }])
    await manager.set(instanceId, databaseId, false)

    const reopened = ManagedRuntime.make(
      makeRelayStateLayer(join(harness.config.dataDirectory, "relay.sqlite"))
    )
    try {
      const recovered = new DatabaseConnections(
        harness.config,
        await reopened.runPromise(RelayStateStore)
      )
      await recovered.initialize([
        snapshot({ labels: connectionLabels([{ databaseId, relayId }]) }),
      ])
      expect(await recovered.labels(instanceId)).toEqual(connectionLabels([]))
    } finally {
      await reopened.dispose()
    }
  })

  it("prefers live local memberships over stale labels and keeps remote references", async () => {
    const { manager, server } = await setup()
    const remote = { databaseId: "d".repeat(40), relayId: remoteRelayId }
    await manager.initialize([
      snapshot({ labels: connectionLabels([{ databaseId, relayId }, remote]) }),
    ])

    expect(await manager.labels(instanceId)).toEqual(connectionLabels([remote]))
    await manager.reconcile(instanceId, "server")
    expect(server.networks.size).toBe(0)
  })

  it("recovers a label reference whose database network is temporarily absent", async () => {
    const { manager, server } = await setup()
    const missing = { databaseId: "e".repeat(40), relayId }
    await manager.initialize([snapshot({ labels: connectionLabels([missing]) })])
    expect(await manager.labels(instanceId)).toEqual(connectionLabels([missing]))
    await manager.set(instanceId, databaseId, true)

    const issues = await manager.reconcile(instanceId, "server")

    expect(issues.map((issue) => issue.databaseId)).toEqual([missing.databaseId])
    expect(server.networks.has(network)).toBe(true)
    expect(await manager.labels(instanceId)).toEqual(
      connectionLabels([missing, { databaseId, relayId }])
    )
  })

  it("reconnects replacement containers, removes stale attachments, and leaves unrelated networks alone", async () => {
    const { manager } = await setup()
    const replacement = fakeDocker.addContainer({ name: "replacement", running: true })
    fakeDocker.connect("replacement", "foreign-network")
    await manager.initialize([])
    await manager.set(instanceId, databaseId, true)

    await manager.reconcile(instanceId, "replacement")
    expect([...replacement.networks.keys()].sort()).toEqual(["foreign-network", network])
    expect(await manager.reconcile(instanceId, "replacement")).toEqual([])

    await manager.set(instanceId, databaseId, false)
    await manager.reconcile(instanceId, "replacement")
    expect([...replacement.networks.keys()]).toEqual(["foreign-network"])
  })

  it("retains desired connections after Docker fails and cleans up deleted servers and databases", async () => {
    const { harness, manager, server } = await setup()
    await manager.initialize([])
    await manager.set(instanceId, databaseId, true)
    fakeDocker.failNext({ command: "network connect", target: network }, "Docker unavailable")

    expect(await manager.reconcile(instanceId, "server")).toEqual([
      { databaseId, message: expect.stringContaining("Docker unavailable") },
    ])
    expect(server.networks.has(network)).toBe(false)
    expect(await manager.reconcile(instanceId, "server")).toEqual([])
    expect(server.networks.has(network)).toBe(true)
    expect(manager.issues(instanceId)).toEqual([])

    const otherServer = "f".repeat(40)
    await manager.set(otherServer, databaseId, true)
    await manager.forgetInstance(instanceId)
    expect(await manager.labels(instanceId)).toEqual(connectionLabels([]))
    expect(
      await Effect.runPromise(harness.state.listInstanceDatabaseConnections(otherServer))
    ).toHaveLength(1)
    await manager.forgetDatabase(databaseId)
    expect(await manager.labels(otherServer)).toEqual(connectionLabels([]))
  })

  it("isolates a vanished network and a failed attachment from healthy connections", async () => {
    const { manager, server } = await setup()
    databaseNetwork("healthy", healthyId)
    const vanished = databaseNetwork("vanished", "e".repeat(40))
    await manager.set(instanceId, databaseId, true)
    await manager.set(instanceId, healthyId, true)
    const inspect = fakeDocker.hold({
      command: "network inspect",
      target: vanished.id.slice(0, 12),
    })
    fakeDocker.failNext(
      { command: "network connect", target: network },
      "network disappeared before connect"
    )

    const reconciling = manager.reconcile(instanceId, "server")
    await inspect.reached
    fakeDocker.networks.delete("vanished")
    inspect.release()
    const issues = await reconciling

    expect(issues).toHaveLength(2)
    expect(issues.some((issue) => issue.databaseId === databaseId)).toBe(true)
    expect(server.networks.has("healthy")).toBe(true)
    expect(await manager.labels(instanceId)).toEqual(
      connectionLabels([
        { databaseId, relayId },
        { databaseId: healthyId, relayId },
      ])
    )
  })

  it("reports discovery failure without rejecting server startup", async () => {
    const { manager } = await setup()
    await manager.set(instanceId, databaseId, true)
    fakeDocker.failNext({ command: "network ls" }, "Docker unavailable")

    expect(await manager.reconcile(instanceId, "server")).toEqual([
      { databaseId: null, message: expect.stringContaining("Docker unavailable") },
    ])
    expect(await manager.labels(instanceId)).toEqual(
      connectionLabels([{ databaseId, relayId }])
    )
  })

  it("recognizes only owned database network names even when the network no longer exists", async () => {
    const { manager } = await setup()

    expect(
      manager.isDatabaseNetwork(`${TEST_NAMESPACE}-kiln-db-${databaseId}-network`)
    ).toBe(true)
    expect(manager.isDatabaseNetwork(`foreign-kiln-db-${databaseId}-network`)).toBe(false)
    expect(manager.isDatabaseNetwork(`${TEST_NAMESPACE}-kiln-minecraft`)).toBe(false)
    expect(manager.isDatabaseNetwork(`${TEST_NAMESPACE}-kiln-db-invalid-network`)).toBe(
      false
    )
  })

  it.each(["network ls", "network inspect"])(
    "imports live and labeled references once when %s fails during recovery",
    async (failing) => {
      const { harness, manager } = await setup()
      const ownedNetwork = `${TEST_NAMESPACE}-kiln-db-${databaseId}-network`
      const missing = { databaseId: "e".repeat(40), relayId }
      const recovering = snapshot({
        labels: connectionLabels([missing]),
        networks: [ownedNetwork, `foreign-kiln-db-${"f".repeat(40)}-network`],
      })
      fakeDocker.failNext({ command: failing }, "Network disappeared")

      await manager.initialize([recovering])

      expect(await manager.labels(instanceId)).toEqual(
        connectionLabels([{ databaseId, relayId }, missing])
      )
      expect(manager.saved(instanceId)).toHaveLength(2)
      await manager.set(instanceId, databaseId, false)
      await (await harness.restart()).databaseConnections.initialize([recovering])
      expect(await manager.labels(instanceId)).toEqual(connectionLabels([missing]))
    }
  )

  it("removes a missing database reference without attaching it, including remote references", async () => {
    const { manager, server } = await setup()
    const remote = { databaseId: "e".repeat(40), relayId: remoteRelayId }
    await manager.initialize([snapshot({ labels: connectionLabels([remote]) })])

    await manager.set(instanceId, remote.databaseId, false, relayId)
    expect(manager.saved(instanceId)).toEqual([expect.objectContaining(remote)])
    await manager.set(instanceId, remote.databaseId, false, remoteRelayId)

    expect(await manager.reconcile(instanceId, "server")).toEqual([])
    expect(manager.saved(instanceId)).toEqual([])
    expect(await manager.labels(instanceId)).toEqual(connectionLabels([]))
    expect(server.networks.size).toBe(0)
  })
})
