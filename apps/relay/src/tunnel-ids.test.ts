import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { migratedTunnelId } from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { physicalKey, useInstanceLegacyIds } from "./instance-keys.js"
import { TUNNEL_ID_LABEL } from "./lifecycle.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"
import { migrateTunnelIds } from "./tunnel-ids.js"

const relayId = "7".repeat(12)
const networkId = "b".repeat(12)
const owner = { "kiln.relay.owner": TEST_NAMESPACE }

// A Tailscale network's stack as a Relay saved it while the stack ran as a
// game server: its folder and every file named by the network's ID, and a
// removal's snapshot of it reading as a game server.
async function networkStack(root: string, folder = networkId) {
  const directory = join(root, folder)
  await mkdir(directory, { recursive: true })
  const stack = {
    bindings: [
      {
        address: "10.165.55.10",
        enabled: true,
        hostname: "survival",
        memberId: `instance:${"c".repeat(12)}`,
      },
    ],
    domain: "test",
    hostname: "private-network",
    id: networkId,
    name: "Private Network",
    subnet: "10.165.55.0/24",
  }
  await writeFile(join(directory, "stack.json"), JSON.stringify(stack))
  await writeFile(
    join(directory, "dns-records.json"),
    JSON.stringify({
      id: networkId,
      records: [{ address: "10.165.55.10", hostname: "survival" }],
    })
  )
  await writeFile(
    join(directory, ".removing-stack.json"),
    JSON.stringify({
      ...stack,
      components: { coreDnsRunning: false, tailscaleRunning: false },
      instance: { id: networkId, observedState: "stopped" },
      status: {
        connected: false,
        ipv4Address: null,
        ipv6Address: null,
        message: "Removal pending",
      },
    })
  )
  return directory
}

const read = async (directory: string, file: string) =>
  JSON.parse(await readFile(join(directory, file), "utf8")) as Record<
    string,
    unknown
  >

describe("Tailscale network stacks becoming tunnels", () => {
  it("gives a stack its tunnel's ID and keeps its folder, members and records", async () => {
    const harness = await relayHarness()
    const directory = await networkStack(harness.config.rootDirectory)
    const tunnelId = await migratedTunnelId(networkId, relayId)
    const input = { config: harness.config, relayId, state: harness.state }

    expect(await migrateTunnelIds(input)).toBe(1)

    // Named by its old key, it is the tunnel's now.
    expect(physicalKey(tunnelId)).toBe(networkId)
    const stack = await read(directory, "stack.json")
    expect(stack).toMatchObject({ id: tunnelId, subnet: "10.165.55.0/24" })
    expect(stack.bindings).toHaveLength(1)
    expect(await read(directory, "dns-records.json")).toMatchObject({
      id: tunnelId,
      records: [{ address: "10.165.55.10", hostname: "survival" }],
    })
    const snapshot = await read(directory, ".removing-stack.json")
    expect(snapshot).toMatchObject({ id: tunnelId, observedState: "stopped" })
    expect(snapshot).not.toHaveProperty("instance")

    // Once is enough.
    expect(await migrateTunnelIds(input)).toBe(0)
    expect(physicalKey(tunnelId)).toBe(networkId)
    useInstanceLegacyIds([])
  })

  // The Relay may stop between recording the tunnel's key and rewriting
  // its files; the next start finishes the move with the same ID.
  it("finishes a move the Relay stopped in the middle of", async () => {
    const harness = await relayHarness()
    const directory = await networkStack(harness.config.rootDirectory)
    const tunnelId = await migratedTunnelId(networkId, relayId)
    await Effect.runPromise(
      harness.state.instanceIds.moveToTunnel({
        legacyId: networkId,
        networkId,
        tunnelId,
      })
    )

    await migrateTunnelIds({
      config: harness.config,
      relayId,
      state: harness.state,
    })

    expect(await read(directory, "stack.json")).toMatchObject({ id: tunnelId })
    expect(physicalKey(tunnelId)).toBe(networkId)
    useInstanceLegacyIds([])
  })

  it("makes a stack's containers again as a tunnel's, and leaves a stopped one stopped", async () => {
    const harness = await relayHarness()
    await networkStack(harness.config.rootDirectory)
    const tunnelId = await migratedTunnelId(networkId, relayId)
    await migrateTunnelIds({
      config: harness.config,
      relayId,
      state: harness.state,
    })
    const name = harness.resources.tunnelContainer(tunnelId)
    fakeDocker.tailscale.machines.set(name, {
      ipv4: "100.64.0.9",
      loggedIn: true,
    })
    // As it ran, stopped, while it read as a game server.
    fakeDocker.addContainer({
      image: "tailscale/tailscale:stable",
      labels: {
        ...owner,
        "kiln.relay.managed": "true",
        "kiln.server.id": networkId,
        "kiln.brick.id": "tailscale",
      },
      name,
      running: false,
    })

    expect(await harness.lifecycle.relabelTunnels()).toBe(1)

    const tailscale = fakeDocker.container(name)!
    expect(tailscale.labels[TUNNEL_ID_LABEL]).toBe(networkId)
    expect(tailscale.labels).not.toHaveProperty("kiln.server.id")
    expect(tailscale.state.running).toBe(false)
    const dns = fakeDocker.container(
      harness.resources.tunnelDnsContainer(tunnelId)
    )!
    expect(dns.labels[TUNNEL_ID_LABEL]).toBe(networkId)
    // Its key still names it, and once is enough.
    expect(name).toContain(networkId.slice(0, 8))
    expect(await harness.lifecycle.relabelTunnels()).toBe(0)
    useInstanceLegacyIds([])
  })
})
