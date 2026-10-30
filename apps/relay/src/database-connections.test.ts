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
const relayId = "relay-with_hyphens".padEnd(43, "x")
const remoteRelayId = "r".repeat(43)
const network = "owned-database-network"

type Reference = { databaseId: string; relayId: string }

const member = (id: string) => ({ id, kind: "instance" as const })

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
    await manager.set(member(instanceId), databaseId, true)
    await manager.set(
      member(instanceId),
      remote.databaseId,
      true,
      remoteRelayId
    )

    const labels = await manager.labels(instanceId)
    expect(labels).toEqual(connectionLabels([{ databaseId, relayId }, remote]))

    const other = await relayHarness()
    other.config.nodeId = "o".repeat(43)
    await other.databaseConnections.initialize([snapshot({ labels })])
    expect(await other.databaseConnections.labels(instanceId)).toEqual(labels)
    expect(harness.config.nodeId).toBe(relayId)
  })

  it("imports existing attachments once and keeps disconnects across reopening SQLite", async () => {
    const { harness, manager } = await setup()
    await manager.initialize([snapshot({ networks: [network] })])
    expect(
      await Effect.runPromise(
        harness.state.listMemberDatabaseConnections(member(instanceId))
      )
    ).toEqual([
      { databaseId, memberId: instanceId, memberKind: "instance", relayId },
    ])
    await manager.set(member(instanceId), databaseId, false)

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

  it("reconnects replacement containers, removes stale attachments, and leaves unrelated networks alone", async () => {
    const { manager } = await setup()
    const replacement = fakeDocker.addContainer({
      name: "replacement",
      running: true,
    })
    fakeDocker.connect("replacement", "foreign-network")
    await manager.initialize([])
    await manager.set(member(instanceId), databaseId, true)

    await manager.reconcile(member(instanceId), [{ container: "replacement" }])
    expect([...replacement.networks.keys()].sort()).toEqual([
      "foreign-network",
      network,
    ])
    expect(
      await manager.reconcile(member(instanceId), [
        { container: "replacement" },
      ])
    ).toEqual([])

    await manager.set(member(instanceId), databaseId, false)
    await manager.reconcile(member(instanceId), [{ container: "replacement" }])
    expect([...replacement.networks.keys()]).toEqual(["foreign-network"])
  })
})
