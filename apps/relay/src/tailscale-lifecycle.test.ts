import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  appTailscaleMemberId,
  databaseTailscaleMemberId,
  instanceTailscaleMemberId,
  tunnelConfigSchema,
  type TunnelConfig,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { exclusive, laneKeys } from "./operation-lanes.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const owner = { "kiln.relay.owner": TEST_NAMESPACE }
const tailnetId = "f".repeat(12)
// Kiln's `tailscale` Brick, as a tunnel made from it keeps it.
const tailscaleBrick = {
  id: "tailscale",
  images: {
    dns: "coredns/coredns:1.14.7",
    tailscale: "tailscale/tailscale:stable",
  },
  revision: 1,
  source: "https://bricks.example/bricks/tailscale.yml",
}
// Its recipe, as Hearth sends it to make a tunnel.
const tailscaleRecipe = {
  format: "kiln.brick/v2" as const,
  kind: "tunnel" as const,
  type: "tailscale",
  metadata: {
    author: "Kiln",
    id: "tailscale",
    name: "Tailscale",
    summary: "Reach what runs on a Relay by name.",
  },
  deploy: { type: "image" as const, image: "tailscale/tailscale:stable" },
  tunnel: { dns: { image: "coredns/coredns:1.14.7" } },
}

function stackConfig(
  id: string,
  overrides: Partial<TunnelConfig> = {}
): TunnelConfig {
  return tunnelConfigSchema.parse({
    bindings: [],
    brick: tailscaleBrick,
    domains: ["test"],
    hostname: "private-network",
    id,
    name: "Private Network",
    subnet: "10.165.55.0/24",
    tailnetId: tailnetId,
    ...overrides,
  })
}

/** Writes a stack that Relay already prepared for removal. */
async function preparedRemoval(harness: RelayHarness, config: TunnelConfig) {
  const directory = join(harness.config.rootDirectory, config.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "stack.json"), JSON.stringify(config))
  await writeFile(join(directory, ".removing"), "prepared\n")
  return directory
}

function stackContainer(harness: RelayHarness, id: string, running: boolean) {
  const name = harness.resources.tunnelContainer(id)
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
  config: TunnelConfig,
  records: ReadonlyArray<{ address: string; name: string }>
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
  const config = tunnelConfigSchema.parse(
    JSON.parse(await readFile(join(directory, "stack.json"), "utf8"))
  )
  const records = JSON.parse(
    await readFile(join(directory, "dns-records.json"), "utf8")
  ).records as Array<{ address: string; name: string }>
  // What CoreDNS answers from: the hosts file in its folder.
  const hosts = await readFile(join(directory, "dns", "hosts"), "utf8").catch(
    () => null
  )
  return {
    hosts,
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
    const id = "b".repeat(12)
    const directory = await preparedRemoval(harness, stackConfig(id))
    const container = stackContainer(harness, id, true)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tunnelNetwork(id),
    })
    fakeDocker.tailscale.controlPlaneReachable = false

    await expect(harness.lifecycle.removeTunnel(id)).rejects.toThrow(
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

    await harness.lifecycle.removeTunnel(id)

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
    const id = "c".repeat(12)
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
              memberId: `instance:${"d".repeat(12)}`,
            },
            {
              address: "10.165.57.11",
              enabled: false,
              memberId: `instance:${"e".repeat(12)}`,
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

    await harness.lifecycle.reconcileTunnelFirewalls()

    expect(container.firewall.get("KILN-TAILSCALE")).toEqual(allowlist)
    expect(container.firewall.get("FORWARD")).toEqual([
      "-A FORWARD -i tailscale0 -j KILN-TAILSCALE",
    ])
  })

  it("restores the allowlist while the Relay is paused, after what holds the stack", async () => {
    const harness = await relayHarness()
    const container = await runningStack(harness)
    // A change to the stack, already running as the Relay is paused.
    let started!: () => void
    let release!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    const holder = Effect.runPromise(
      harness.lanes
        .admit({
          label: "tunnel.apply",
          locks: [exclusive(laneKeys.instance("c".repeat(12)))],
        })
        .run(
          Effect.promise(() => {
            started()
            return released
          })
        )
    )
    await running
    harness.lanes.setPaused(true)

    await harness.lifecycle.reconcileTunnelFirewalls()
    expect(container.firewall.get("KILN-TAILSCALE")).toBeUndefined()

    release()
    await holder
    await harness.lifecycle.reconcileTunnelFirewalls()
    expect(harness.lanes.paused).toBe(true)
    expect(container.firewall.get("KILN-TAILSCALE")).toEqual(allowlist)
  })
})

const deletion = "11111111-1111-4111-8111-111111111111"
const quiet = async () => {}

describe("tailnet members", () => {
  const stackId = "f".repeat(12)
  const serverId = "a".repeat(12)
  const otherServerId = "1".repeat(12)
  const appId = "e".repeat(12)
  const databaseId = "d".repeat(12)
  // Named for the reader: Hearth keeps members' names, not the Relay.
  const binding = (memberId: string, _name: string, host: number) => ({
    address: `10.165.60.${host}`,
    enabled: true,
    memberId,
  })
  // Hearth's records: a peer node's member, and this node's game server.
  const hearthRecords = [
    { address: "10.165.61.10", name: "peer.test" },
    { address: "10.165.60.10", name: "paper.test" },
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

  it("serves Hearth's records, not its own members, as an apply recreates CoreDNS", async () => {
    const harness = await relayHarness()
    await savedStack(harness, servers, hearthRecords)
    for (const id of [serverId, otherServerId]) await harness.seedServer({ id })
    // The stack's own container, which Relay lists as a game server.
    const stack = harness.resources.tunnelContainer(stackId)
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
      name: harness.resources.tunnelNetwork(stackId),
    })

    await harness.lifecycle.applyTunnel({
      bindings: [
        {
          enabled: true,
          memberId: instanceTailscaleMemberId(serverId),
        },
        {
          enabled: true,
          memberId: instanceTailscaleMemberId(otherServerId),
        },
      ],
      domains: servers.domains,
      hostname: servers.hostname,
      id: stackId,
      tailnetId,
      name: servers.name,
    })

    const saved = await savedState(harness, stackId)
    expect(saved.records).toEqual(hearthRecords)
    expect(saved.hosts).toContain("10.165.61.10 peer.test")
    expect(saved.hosts).not.toContain("other.test")
  })
})

describe("Tailscale forwarding repair", () => {
  const stackId = "9".repeat(12)
  const serverId = "a".repeat(12)
  const otherServerId = "1".repeat(12)
  const binding = (
    memberId: string,
    _name: string,
    host: number,
    enabled: boolean
  ) => ({ address: `10.165.63.${host}`, enabled, memberId })
  const before = stackConfig(stackId, {
    bindings: [
      binding(instanceTailscaleMemberId(serverId), "paper", 10, true),
      binding(instanceTailscaleMemberId(otherServerId), "other", 14, false),
    ],
    subnet: "10.165.63.0/24",
  })

  it("leaves the rules an apply installs when it races a repair", async () => {
    const harness = await relayHarness()
    await savedStack(harness, before, [])
    for (const id of [serverId, otherServerId]) await harness.seedServer({ id })
    const stack = harness.resources.tunnelContainer(stackId)
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
      name: harness.resources.tunnelNetwork(stackId),
    })

    // The repair stops as it first looks at the stack's rules.
    const looking = fakeDocker.hold({ command: "exec", target: stack })
    const repair = harness.lifecycle.reconcileTunnelFirewalls()
    await looking.reached
    const applying = harness.lanes.admit({
      label: "tunnel.apply",
      locks: [exclusive(laneKeys.instance(stackId))],
    })
    const applied = Effect.runPromise(
      applying.run(
        Effect.promise(() =>
          harness.lifecycle.applyTunnel({
            bindings: before.bindings.map(({ memberId }) => ({
              enabled: true,
              memberId,
            })),
            domains: before.domains,
            hostname: before.hostname,
            id: stackId,
            tailnetId,
            name: before.name,
          })
        )
      )
    )
    // Whatever the lanes let run beside the repair finishes before it goes on.
    if (applying.grantedAtOnce) await applied
    looking.release()
    await Promise.all([repair, applied])
    await harness.lifecycle.reconcileTunnelFirewalls()

    const saved = tunnelConfigSchema.parse(
      JSON.parse(
        await readFile(
          join(harness.config.rootDirectory, stackId, "stack.json"),
          "utf8"
        )
      )
    )
    expect(saved.bindings.every((member) => member.enabled)).toBe(true)
    expect(fakeDocker.container(stack)?.firewall.get("KILN-TAILSCALE")).toEqual(
      [
        ...saved.bindings.map(
          ({ address }) => `-A KILN-TAILSCALE -d ${address}/32 -j RETURN`
        ),
        "-A KILN-TAILSCALE -j DROP",
      ]
    )
  })
})

describe("A tunnel as an instance", () => {
  async function runningTunnel(harness: RelayHarness, id: string) {
    await savedStack(harness, stackConfig(id), [
      { address: "10.165.55.10", name: "paper.test" },
    ])
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tunnelNetwork(id),
    })
    const tailscale = stackContainer(harness, id, true)
    const dns = fakeDocker.addContainer({
      image: "coredns/coredns:1.14.7",
      labels: owner,
      name: harness.resources.tunnelDnsContainer(id),
      running: true,
    })
    return { dns, tailscale }
  }

  // Its CoreDNS lives in its Tailscale container's network, so the two go
  // down and come up together.
  it("stops and starts both its containers together", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(12)
    await runningTunnel(harness, id)
    const running = (name: string) =>
      fakeDocker.container(name)?.state.running ?? false

    const stopped = await harness.power.requested("tunnel", id, "stop")
    expect(stopped.observedState).toBe("stopped")
    expect(running(harness.resources.tunnelContainer(id))).toBe(false)
    expect(running(harness.resources.tunnelDnsContainer(id))).toBe(false)

    const started = await harness.power.requested("tunnel", id, "start")
    expect(started.observedState).toBe("running")
    expect(running(harness.resources.tunnelContainer(id))).toBe(true)
    expect(running(harness.resources.tunnelDnsContainer(id))).toBe(true)
  })

  it("deploys again from images pulled anew, keeping its identity and records", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    const { tailscale } = await runningTunnel(harness, id)
    const phases: Array<string> = []

    const redeployed = await harness.lifecycle.redeployTunnel(
      id,
      async (phase) => {
        phases.push(phase)
      },
      async () => undefined
    )

    expect(phases).toEqual([
      "pulling_image",
      "creating_container",
      "finalizing",
    ])
    expect([...fakeDocker.pulls.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tailscale/tailscale"),
        expect.stringContaining("coredns/coredns"),
      ])
    )
    const replaced = fakeDocker.container(harness.resources.tunnelContainer(id))
    expect(replaced?.id).not.toBe(tailscale.id)
    expect(replaced?.state.running).toBe(true)
    expect(redeployed).toMatchObject({ id, observedState: "running" })
    expect((await savedState(harness, id)).records).toEqual([
      { address: "10.165.55.10", name: "paper.test" },
    ])
  })
})

describe("A tunnel's DNS", () => {
  // CoreDNS reads its records again by itself, so a change never makes the
  // container again or drops a query.
  it("serves new records without making its CoreDNS again", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(12)
    await savedStack(harness, stackConfig(id), [
      { address: "10.165.55.10", name: "paper.test" },
    ])
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tunnelNetwork(id),
    })
    stackContainer(harness, id, true)
    await harness.lifecycle.syncTunnelDns({
      id,
      records: [{ address: "10.165.55.10", name: "paper.test" }],
    })
    const dns = harness.resources.tunnelDnsContainer(id)
    const before = fakeDocker.container(dns)?.id

    await harness.lifecycle.syncTunnelDns({
      id,
      records: [
        { address: "10.165.55.10", name: "paper.test" },
        { address: "10.165.55.11", name: "survival.test" },
      ],
    })

    expect(fakeDocker.container(dns)?.id).toBe(before)
    expect((await savedState(harness, id)).hosts).toBe(
      "10.165.55.10 paper.test\n10.165.55.11 survival.test\n"
    )
  })
})

describe("A tunnel's Brick", () => {
  // Kiln's login, routes, firewall and DNS are made for the type's own
  // images; a Brick that runs anything else makes nothing.
  it("refuses one that runs another image, before anything is made", async () => {
    const harness = await relayHarness()
    const id = "8".repeat(12)

    await expect(
      harness.lifecycle.applyTunnel({
        authKey: "tskey-auth-k0000000000000CNTRL-0000000000000000000000000000",
        bindings: [],
        brick: {
          definition: {
            ...tailscaleRecipe,
            deploy: { type: "image", image: "example/tailscale:stable" },
          },
          source: tailscaleBrick.source,
        },
        domains: ["test"],
        hostname: "home",
        id,
        name: "Home",
        tailnetId,
      })
    ).rejects.toThrow(/tailscale\/tailscale image/u)
    expect(
      fakeDocker.container(harness.resources.tunnelContainer(id))
    ).toBeUndefined()
    await expect(
      access(join(harness.config.rootDirectory, id, "stack.json"))
    ).rejects.toThrow()
  })

  it("is the one it was made from, whatever a later apply names", async () => {
    const harness = await relayHarness()
    const id = "7".repeat(12)
    const config = stackConfig(id)
    await savedStack(harness, config, [])
    stackContainer(harness, id, true)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tunnelNetwork(id),
    })

    const applied = await harness.lifecycle.applyTunnel({
      bindings: [],
      brick: {
        definition: {
          ...tailscaleRecipe,
          deploy: { type: "image", image: "tailscale/tailscale:v1.90.0" },
        },
        source: "https://bricks.example/bricks/newer.yml",
      },
      domains: config.domains,
      hostname: config.hostname,
      id,
      name: config.name,
      tailnetId,
    })

    expect(applied.brick).toEqual(tailscaleBrick)
  })
})
