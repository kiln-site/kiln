import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  appTailscaleMemberId,
  databaseTailscaleMemberId,
  instanceTailscaleMemberId,
  relayTailscaleStackConfigSchema,
  type RelayTailscaleStackConfig,
} from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const owner = { "kiln.relay.owner": TEST_NAMESPACE }

function stackConfig(
  id: string,
  overrides: Partial<RelayTailscaleStackConfig> = {}
): RelayTailscaleStackConfig {
  return relayTailscaleStackConfigSchema.parse({
    bindings: [],
    domain: "test",
    hostname: "private-network",
    id,
    name: "Private Network",
    subnet: "10.165.55.0/24",
    ...overrides,
  })
}

/** Writes a stack that Relay already prepared for removal. */
async function preparedRemoval(
  harness: RelayHarness,
  config: RelayTailscaleStackConfig
) {
  const directory = join(harness.config.rootDirectory, config.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "stack.json"), JSON.stringify(config))
  await writeFile(join(directory, ".removing"), "prepared\n")
  return directory
}

function stackContainer(harness: RelayHarness, id: string, running: boolean) {
  const name = harness.resources.tailscaleStackContainer(id)
  fakeDocker.tailscale.machines.set(name, {
    ipv4: "100.64.0.9",
    loggedIn: true,
  })
  return fakeDocker.addContainer({
    image: "tailscale/tailscale:stable",
    labels: owner,
    name,
    running,
  })
}

/** Writes a stack as Relay saved it, with the DNS records Hearth last sent. */
async function savedStack(
  harness: RelayHarness,
  config: RelayTailscaleStackConfig,
  records: ReadonlyArray<{ address: string; hostname: string }>
) {
  const directory = join(harness.config.rootDirectory, config.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "stack.json"), JSON.stringify(config))
  await writeFile(
    join(directory, "dns-records.json"),
    JSON.stringify({ id: config.id, records })
  )
  return directory
}

/** What the stack saves and what its CoreDNS serves, as read from disk. */
async function savedState(harness: RelayHarness, id: string) {
  const directory = join(harness.config.rootDirectory, id)
  const config = relayTailscaleStackConfigSchema.parse(
    JSON.parse(await readFile(join(directory, "stack.json"), "utf8"))
  )
  const records = JSON.parse(
    await readFile(join(directory, "dns-records.json"), "utf8")
  ).records as Array<{ address: string; hostname: string }>
  const corefile = await readFile(join(directory, "Corefile"), "utf8").catch(
    () => null
  )
  return {
    corefile,
    members: config.bindings.map((binding) => binding.memberId),
    records,
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

describe("Tailscale stack removal", () => {
  it("preserves the machine identity when logout fails and logs out on retry", async () => {
    const harness = await relayHarness()
    const id = "b".repeat(40)
    const directory = await preparedRemoval(harness, stackConfig(id))
    const container = stackContainer(harness, id, true)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tailscaleStackNetwork(id),
    })
    fakeDocker.tailscale.controlPlaneReachable = false

    await expect(harness.lifecycle.removeTailscaleStack(id)).rejects.toThrow(
      "local identity was preserved for retry"
    )
    expect(await exists(join(directory, ".removing"))).toBe(true)
    expect(fakeDocker.tailscale.machines.get(container.name)?.loggedIn).toBe(
      true
    )

    // The container is gone before the retry, but its identity remains on disk.
    fakeDocker.removeContainer(container.name)
    const stateDirectory = join(
      harness.config.dataDirectory,
      "infrastructure",
      "tailscale-stacks",
      id,
      "state"
    )
    await mkdir(stateDirectory, { recursive: true })
    await writeFile(join(stateDirectory, "tailscaled.state"), "{}\n")
    fakeDocker.tailscale.controlPlaneReachable = true

    await harness.lifecycle.removeTailscaleStack(id)

    expect(fakeDocker.tailscale.machines.get(container.name)?.loggedIn).toBe(
      false
    )
    expect(fakeDocker.container(container.name)).toBeUndefined()
    expect(await exists(directory)).toBe(false)
  })
})

describe("Tailscale stack forwarding", () => {
  const bound = "10.165.57.10"

  async function runningStack(harness: RelayHarness) {
    const id = "c".repeat(40)
    const directory = join(harness.config.rootDirectory, id)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "stack.json"),
      JSON.stringify(
        stackConfig(id, {
          bindings: [
            {
              address: bound,
              enabled: true,
              hostname: "paper",
              memberId: `instance:${"d".repeat(40)}`,
            },
            {
              address: "10.165.57.11",
              enabled: false,
              hostname: "paused",
              memberId: `instance:${"e".repeat(40)}`,
            },
          ],
          subnet: "10.165.57.0/24",
        })
      )
    )
    return stackContainer(harness, id, true)
  }

  const allowlist = [
    `-A KILN-TAILSCALE -d ${bound}/32 -j RETURN`,
    "-A KILN-TAILSCALE -j DROP",
  ]

  it("installs an allowlist for enabled servers that drops all other forwarded traffic", async () => {
    const harness = await relayHarness()
    const container = await runningStack(harness)

    await harness.lifecycle.reconcileTailscaleStackFirewalls()

    expect(container.firewall.get("KILN-TAILSCALE")).toEqual(allowlist)
    expect(container.firewall.get("FORWARD")).toEqual([
      "-A FORWARD -i tailscale0 -j KILN-TAILSCALE",
    ])
  })

  it("restores the allowlist after the stack container restarts", async () => {
    const harness = await relayHarness()
    const container = await runningStack(harness)
    await harness.lifecycle.reconcileTailscaleStackFirewalls()

    fakeDocker.restartProcess(container.name)
    expect(container.firewall.get("KILN-TAILSCALE")).toBeUndefined()
    await harness.lifecycle.reconcileTailscaleStackFirewalls()

    expect(container.firewall.get("KILN-TAILSCALE")).toEqual(allowlist)
  })
})

const deletion = "11111111-1111-4111-8111-111111111111"
const quiet = async () => {}

describe("Tailscale network members", () => {
  const stackId = "f".repeat(40)
  const serverId = "a".repeat(40)
  const otherServerId = "1".repeat(40)
  const appId = "e".repeat(40)
  const databaseId = "d".repeat(40)
  const binding = (memberId: string, hostname: string, host: number) => ({
    address: `10.165.60.${host}`,
    enabled: true,
    hostname,
    memberId,
  })
  // Hearth's records: a peer node's member, and this node's game server.
  const hearthRecords = [
    { address: "10.165.61.10", hostname: "peer" },
    { address: "10.165.60.10", hostname: "paper" },
  ]
  const members = stackConfig(stackId, {
    bindings: [
      binding(instanceTailscaleMemberId(serverId), "paper", 10),
      binding(appTailscaleMemberId(appId, "web"), "web", 11),
      binding(appTailscaleMemberId(appId, "worker"), "worker", 12),
      binding(databaseTailscaleMemberId(databaseId), "postgres", 13),
      binding(instanceTailscaleMemberId(otherServerId), "other", 14),
    ],
    subnet: "10.165.60.0/24",
  })
  // Game servers only, none of which this Relay runs unless a test seeds it.
  const servers = stackConfig(stackId, {
    bindings: [
      binding(instanceTailscaleMemberId(serverId), "paper", 10),
      binding(instanceTailscaleMemberId(otherServerId), "other", 14),
    ],
    subnet: "10.165.60.0/24",
  })

  it("leaves a network's DNS to Hearth as its game servers, Apps, and databases are deleted", async () => {
    const harness = await relayHarness()
    await savedStack(harness, members, hearthRecords)
    stackContainer(harness, stackId, true)
    await harness.seedServer({ id: serverId })
    for (const [kind, id] of [
      ["instance", serverId],
      ["app", appId],
      ["database", databaseId],
    ] as const) {
      await harness.freezes.freeze({ deletionId: deletion, id, kind }, quiet)
    }

    await harness.lifecycle.deleteInstance(serverId, true)
    // An App's and a database's deletions take them off once they're gone.
    await harness.lifecycle.removeFromTailscale((memberId) =>
      memberId.startsWith(`app:${appId}:`)
    )
    await harness.lifecycle.removeFromTailscale(
      (memberId) => memberId === databaseTailscaleMemberId(databaseId)
    )

    const saved = await savedState(harness, stackId)
    expect(saved.members).toEqual([instanceTailscaleMemberId(otherServerId)])
    expect(saved.records).toEqual(hearthRecords)
    expect(
      fakeDocker.container(harness.resources.instanceContainer(serverId))
    ).toBeUndefined()
  })

  it("takes a game server already gone off its networks when its deletion is sent again", async () => {
    const harness = await relayHarness()
    await savedStack(harness, servers, hearthRecords)
    stackContainer(harness, stackId, true)
    await harness.freezes.freeze(
      { deletionId: deletion, id: serverId, kind: "instance" },
      quiet
    )

    await expect(
      harness.lifecycle.deleteInstance(serverId, true)
    ).rejects.toThrow("Instance not found")

    const saved = await savedState(harness, stackId)
    expect(saved.members).toEqual([instanceTailscaleMemberId(otherServerId)])
    expect(saved.records).toEqual(hearthRecords)
  })

  it("serves Hearth's records, not its own members, as an apply recreates CoreDNS", async () => {
    const harness = await relayHarness()
    await savedStack(harness, servers, hearthRecords)
    for (const id of [serverId, otherServerId]) await harness.seedServer({ id })
    // The stack's own container, which Relay lists as a game server.
    const stack = harness.resources.tailscaleStackContainer(stackId)
    fakeDocker.tailscale.machines.set(stack, {
      ipv4: "100.64.0.9",
      loggedIn: true,
    })
    await harness.seedServer({
      id: stackId,
      image: "tailscale/tailscale:stable",
      labels: { "kiln.brick.id": "tailscale" },
      name: stack,
      running: true,
    })
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${stackId}` },
      name: harness.resources.tailscaleStackNetwork(stackId),
    })

    await harness.lifecycle.applyTailscaleStack({
      bindings: [
        {
          enabled: true,
          hostname: "paper",
          memberId: instanceTailscaleMemberId(serverId),
        },
        {
          enabled: true,
          hostname: "other",
          memberId: instanceTailscaleMemberId(otherServerId),
        },
      ],
      domain: servers.domain,
      hostname: servers.hostname,
      id: stackId,
      name: servers.name,
    })

    const saved = await savedState(harness, stackId)
    expect(saved.records).toEqual(hearthRecords)
    expect(saved.corefile).toContain("10.165.61.10 peer.test")
    expect(saved.corefile).not.toContain("other.test")
  })

  it("serves Hearth's records again as a prepared removal rolls back", async () => {
    const harness = await relayHarness()
    await preparedRemoval(harness, servers)
    await savedStack(harness, servers, hearthRecords)
    stackContainer(harness, stackId, false)

    await harness.lifecycle.removeTailscaleStack(stackId, "rollback")

    const saved = await savedState(harness, stackId)
    expect(saved.records).toEqual(hearthRecords)
    expect(saved.corefile).toContain("10.165.61.10 peer.test")
    expect(saved.corefile).not.toContain("other.test")
  })

  it("reports which members are frozen and whether a removal is pending", async () => {
    const harness = await relayHarness()
    await savedStack(harness, members, hearthRecords)
    const removing = stackConfig("b".repeat(40), { subnet: "10.165.62.0/24" })
    await preparedRemoval(harness, removing)
    await harness.freezes.freeze(
      { deletionId: deletion, id: appId, kind: "app" },
      quiet
    )

    const states = await harness.lifecycle.tailscaleStackStates()

    const state = states.find(({ id }) => id === stackId)
    expect(
      state?.bindings
        .filter((binding) => binding.frozen)
        .map((binding) => binding.memberId)
    ).toEqual([
      appTailscaleMemberId(appId, "web"),
      appTailscaleMemberId(appId, "worker"),
    ])
    expect(state?.removalPending).toBe(false)
    expect(states.find(({ id }) => id === removing.id)?.removalPending).toBe(
      true
    )
  })
})
