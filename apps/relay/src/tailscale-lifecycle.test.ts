import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  builtinTailscaleBrickId,
  relayCreateDatabaseSchema,
  relayTailscaleStackApplySchema,
  relayTailscaleStackConfigSchema,
  relayTailscaleStackSchema,
  type RelayTailscaleStackConfig,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import type { RelayInstanceConfig } from "./config.js"
import { DockerEngine } from "./docker-engine.js"
import { exclusive, laneKeys } from "./operation-lanes.js"
import { controlRequestLocks } from "./operation-plans.js"
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
  config: RelayTailscaleStackConfig,
  snapshot?: unknown
) {
  const directory = join(harness.config.rootDirectory, config.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "stack.json"), JSON.stringify(config))
  await writeFile(join(directory, ".removing"), "prepared\n")
  if (snapshot) {
    await writeFile(
      join(directory, ".removing-stack.json"),
      JSON.stringify(snapshot)
    )
  }
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

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

describe("Tailscale stack removal", () => {
  it("starts a stopped stack container to log its machine out before cleanup", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    const directory = await preparedRemoval(harness, stackConfig(id))
    const container = stackContainer(harness, id, false)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: harness.resources.tailscaleStackNetwork(id),
    })

    await harness.lifecycle.removeTailscaleStack(id)

    expect(fakeDocker.tailscale.machines.get(container.name)?.loggedIn).toBe(
      false
    )
    expect(fakeDocker.container(container.name)).toBeUndefined()
    expect(
      fakeDocker.networks.has(harness.resources.tailscaleStackNetwork(id))
    ).toBe(false)
    expect(await exists(directory)).toBe(false)
  })

  it("keeps a failed removal pending and refuses to revive the stack until cleanup finishes", async () => {
    const harness = await relayHarness()
    const id = "a".repeat(40)
    const config = stackConfig(id)
    const service = harness.resources.tailscaleStackContainer(id)
    const directory = await preparedRemoval(
      harness,
      config,
      relayTailscaleStackSchema.parse({
        ...config,
        components: { coreDnsRunning: false, tailscaleRunning: false },
        instance: {
          brickId: builtinTailscaleBrickId,
          connectAddress: "private-network.test",
          containerId: "docker-container-id",
          desiredState: "stopped",
          directory: id,
          game: "Networking",
          id,
          implementation: "Tailscale",
          javaVersion: "Tailscale + CoreDNS",
          managedByRelay: true,
          name: "Private Network",
          observedState: "stopped",
          service,
          shortId: id.slice(0, 8),
          status: "Exited (0)",
          version: "stable",
        },
        status: {
          connected: false,
          ipv4Address: null,
          ipv6Address: null,
          message: "Tailscale is stopped",
        },
      })
    )
    const network = harness.resources.tailscaleStackNetwork(id)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${id}` },
      name: network,
    })
    // Something outside the stack is still attached, so Docker refuses rm.
    fakeDocker.addContainer({ name: "debug-shell", networks: [network] })

    await expect(harness.lifecycle.removeTailscaleStack(id)).rejects.toThrow(
      "active endpoints"
    )
    const [pending] = await harness.lifecycle.tailscaleStacks()
    expect(pending).toMatchObject({
      bindings: config.bindings,
      components: { coreDnsRunning: false, tailscaleRunning: false },
      id,
      instance: { containerId: null, observedState: "stopped" },
      status: { connected: false },
    })

    const dockerBefore = structuredClone([...fakeDocker.containers.keys()])
    await expect(
      harness.lifecycle.applyTailscaleStack(
        relayTailscaleStackApplySchema.parse({
          bindings: [],
          domain: "test",
          hostname: "private-network",
          id,
          name: "Private Network",
        })
      )
    ).rejects.toThrow("removal cleanup is pending")
    const instance: RelayInstanceConfig = {
      brickId: builtinTailscaleBrickId,
      connectAddress: "private-network.test",
      directory: id,
      game: "Networking",
      id,
      implementation: "Tailscale",
      javaVersion: "Tailscale + CoreDNS",
      limits: {
        cpuMillis: null,
        diskBytes: 128 * 1024 ** 2,
        memoryBytes: 64 * 1024 ** 2,
      },
      managedByRelay: true,
      name: "Private Network",
      ports: [],
      service,
      shortId: id.slice(0, 8),
      tailscale: { enabled: false },
      version: "stable",
    }
    for (const action of ["start", "restart"] as const) {
      await expect(
        harness.lifecycle.runInstanceAction(instance, action, [])
      ).rejects.toThrow("removal cleanup is pending")
    }
    expect([...fakeDocker.containers.keys()]).toEqual(dockerBefore)
    expect(fakeDocker.container(service)).toBeUndefined()

    fakeDocker.removeContainer("debug-shell")
    await harness.lifecycle.removeTailscaleStack(id)

    expect(fakeDocker.networks.has(network)).toBe(false)
    expect(await exists(directory)).toBe(false)
  })

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

  it("repairs an incomplete allowlist", async () => {
    const harness = await relayHarness()
    const container = await runningStack(harness)
    container.firewall.set("FORWARD", [
      "-A FORWARD -i tailscale0 -j KILN-TAILSCALE",
    ])
    container.firewall.set("KILN-TAILSCALE", ["-A KILN-TAILSCALE -j DROP"])

    await harness.lifecycle.reconcileTailscaleStackFirewalls()

    expect(container.firewall.get("KILN-TAILSCALE")).toEqual(allowlist)
    expect(container.firewall.get("FORWARD")).toHaveLength(1)
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

describe("Tailscale members", () => {
  const serverId = "a".repeat(40)
  const stackId = "c".repeat(40)
  const address = "10.165.57.10"

  async function serverOnStack(harness: RelayHarness, start = false) {
    await harness.createServer({ id: serverId, start })
    const network = harness.resources.tailscaleStackNetwork(stackId)
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.relay.network": `tailscale:${stackId}` },
      name: network,
      subnet: "10.165.57.0/24",
    })
    const directory = join(harness.config.rootDirectory, stackId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "stack.json"),
      JSON.stringify(
        stackConfig(stackId, {
          bindings: [
            {
              address,
              enabled: true,
              hostname: "paper",
              memberId: `instance:${serverId}`,
            },
          ],
          subnet: "10.165.57.0/24",
        })
      )
    )
    return { container: harness.resources.instanceContainer(serverId), network }
  }

  // The stack's container as installing it labels it.
  async function installedStack(harness: RelayHarness) {
    const stack = harness.resources.tailscaleStackContainer(stackId)
    fakeDocker.tailscale.machines.set(stack, {
      ipv4: "100.64.0.9",
      loggedIn: true,
    })
    await harness.seedServer({
      id: stackId,
      image: "tailscale/tailscale:stable",
      labels: {
        "kiln.brick.format": "kiln.brick/v1",
        "kiln.brick.id": builtinTailscaleBrickId,
        "kiln.instance.mount": "/config",
        "kiln.instance.name": "Private Network",
      },
      mounts: [
        {
          destination: "/config",
          source: join(harness.config.rootDirectory, stackId),
          type: "bind",
        },
      ],
      name: stack,
      running: true,
    })
  }

  function deleting(
    harness: RelayHarness,
    id: string,
    prepare = async () => {}
  ) {
    return Effect.runPromise(
      harness.lanes.run(
        { label: "instance.delete", locks: [exclusive(laneKeys.instance(id))] },
        Effect.promise(() =>
          harness.lifecycle.deleteInstance(id, false, async ({ mode }) => {
            if (mode === "prepare") await prepare()
          })
        )
      )
    )
  }

  it("removes both members when two deletions detach from one stack concurrently", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    await installedStack(harness)
    const secondId = "b".repeat(40)
    await harness.createServer({ id: secondId })
    const second = harness.resources.instanceContainer(secondId)
    fakeDocker.connect(container, network, address)
    fakeDocker.connect(second, network, "10.165.57.11")
    const path = join(harness.config.rootDirectory, stackId, "stack.json")
    const config = JSON.parse(await readFile(path, "utf8"))
    config.bindings.push({
      address: "10.165.57.11",
      enabled: true,
      hostname: "second",
      memberId: `instance:${secondId}`,
    })
    await writeFile(path, JSON.stringify(config))

    const detach = fakeDocker.hold({
      command: "network disconnect",
      target: network,
    })
    const first = deleting(harness, serverId)
    await detach.reached
    let prepared!: () => void
    const ready = new Promise<void>((resolve) => {
      prepared = resolve
    })
    const other = deleting(harness, secondId, async () => prepared())
    await ready
    // Let the second deletion reach its local detach while the first is
    // paused at Docker, before it has saved its configuration.
    await vi.waitUntil(() =>
      harness.lanes
        .describe()
        .waiting.some(({ label }) => label === "tailscale.member.detach")
    )
    detach.release()
    await Promise.all([first, other])

    expect(JSON.parse(await readFile(path, "utf8")).bindings).toEqual([])
    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([])
  })

  it("rolls back a failed deletion without restoring another member deleted meanwhile", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    await installedStack(harness)
    const secondId = "b".repeat(40)
    await harness.createServer({ id: secondId })
    const second = harness.resources.instanceContainer(secondId)
    fakeDocker.connect(container, network, address)
    fakeDocker.connect(second, network, "10.165.57.11")
    const path = join(harness.config.rootDirectory, stackId, "stack.json")
    const config = JSON.parse(await readFile(path, "utf8"))
    config.bindings.push({
      address: "10.165.57.11",
      enabled: true,
      hostname: "second",
      memberId: `instance:${secondId}`,
    })
    await writeFile(path, JSON.stringify(config))

    const removal = fakeDocker.hold({ command: "rm", target: container })
    const first = deleting(harness, serverId)
    // Attach the failure handler before making Docker fail.
    const failed = expect(first).rejects.toThrow()
    await removal.reached
    await deleting(harness, secondId)
    removal.fail("Docker refused the removal")
    await failed

    expect(
      JSON.parse(await readFile(path, "utf8")).bindings.map(
        (binding: { memberId: string }) => binding.memberId
      )
    ).toEqual([`instance:${serverId}`])
    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([
      { address, memberId: `instance:${serverId}`, network },
    ])
  })

  it.each(["binding conflict", "DNS conflict", "no conflict"])(
    "preserves an apply between detach and rollback with %s",
    async (scenario) => {
      const hostname = scenario === "binding conflict" ? "paper" : "renamed"
      const conflicting = scenario !== "no conflict"
      const harness = await relayHarness()
      const { container, network } = await serverOnStack(harness)
      await installedStack(harness)
      const secondId = "b".repeat(40)
      await harness.createServer({ id: secondId })
      const second = harness.resources.instanceContainer(secondId)
      fakeDocker.connect(container, network, address)
      const path = join(harness.config.rootDirectory, stackId, "stack.json")
      const secondBinding = {
        address: "10.165.57.11",
        enabled: true,
        hostname: "second",
        memberId: `instance:${secondId}`,
      }
      const config = JSON.parse(await readFile(path, "utf8"))
      config.bindings.push(secondBinding)
      await writeFile(path, JSON.stringify(config))
      fakeDocker.connect(second, network, secondBinding.address)

      const removal = fakeDocker.hold({ command: "rm", target: container })
      const deleted = deleting(harness, serverId)
      const failed = expect(deleted).rejects.toThrow(
        conflicting
          ? /Tailscale rollback also failed:.*Hostname paper.test.*stay off the network; finishing the deletion removes them/
          : "Docker refused the removal"
      )
      await removal.reached
      const input = relayTailscaleStackApplySchema.parse({
        bindings: [{ hostname, memberId: secondBinding.memberId }],
        domain: "test",
        hostname: "private-network",
        id: stackId,
        name: "Private Network",
      })
      let basis: string | undefined
      const locks = await controlRequestLocks(
        "relay.tailscale.stack.apply",
        input,
        (id) => id,
        () => [],
        async (id) => {
          const plan = await harness.lifecycle.tailscaleStackPlan(id)
          basis = plan.basis
          return plan.bindings
        },
        (kind, id) => harness.lanes.isFrozen(kind, id)
      )!
      await Effect.runPromise(
        harness.lanes.run(
          { label: "relay.tailscale.stack.apply", locks },
          Effect.promise(() =>
            harness.lifecycle.applyTailscaleStack(input, basis)
          )
        )
      )
      const directory = join(harness.config.rootDirectory, stackId)
      if (scenario === "DNS conflict") {
        await harness.lifecycle.syncTailscaleStackDns({
          id: stackId,
          records: [
            { address: secondBinding.address, hostname },
            { address: "10.165.58.10", hostname: "paper" },
          ],
        })
      }
      const appliedDns = await readFile(join(directory, "Corefile"), "utf8")
      const appliedRecords = await readFile(
        join(directory, "dns-records.json"),
        "utf8"
      )
      removal.fail("Docker refused the removal")
      await failed

      const bindings = JSON.parse(await readFile(path, "utf8")).bindings
      expect(bindings).toContainEqual({ ...secondBinding, hostname })
      expect(fakeDocker.container(second)?.networks.get(network)).toMatchObject(
        {
          ipAddress: secondBinding.address,
        }
      )
      if (conflicting) {
        expect(bindings).toEqual([{ ...secondBinding, hostname }])
        expect(await readFile(join(directory, "Corefile"), "utf8")).toBe(
          appliedDns
        )
        expect(
          await readFile(join(directory, "dns-records.json"), "utf8")
        ).toBe(appliedRecords)
        expect(fakeDocker.container(container)?.networks.has(network)).toBe(
          false
        )
        expect(
          await harness.lifecycle.tailscaleMemberships(() => true)
        ).toEqual([
          {
            address: secondBinding.address,
            memberId: secondBinding.memberId,
            network,
          },
        ])
      } else {
        expect(bindings).toContainEqual(config.bindings[0])
        expect(
          fakeDocker.container(container)?.networks.get(network)
        ).toMatchObject({
          ipAddress: address,
        })
      }
    }
  )

  it("cannot restore a frozen member when an apply overlaps its deletion", async () => {
    const harness = await relayHarness()
    const { network } = await serverOnStack(harness)
    await installedStack(harness)
    await harness.freezes.freeze(
      { deletionId: "d".repeat(36), id: serverId, kind: "instance" },
      async () => {}
    )
    const input = relayTailscaleStackApplySchema.parse({
      bindings: [{ hostname: "paper", memberId: `instance:${serverId}` }],
      domain: "test",
      hostname: "private-network",
      id: stackId,
      name: "Private Network",
    })
    let basis: string | undefined
    const locks = await controlRequestLocks(
      "relay.tailscale.stack.apply",
      input,
      (id) => id,
      () => [],
      async (id) => {
        const plan = await harness.lifecycle.tailscaleStackPlan(id)
        basis = plan.basis
        return plan.bindings
      },
      (kind, id) => harness.lanes.isFrozen(kind, id)
    )!
    const applying = fakeDocker.hold({
      command: "network inspect",
      target: network,
    })
    const applied = Effect.runPromise(
      harness.lanes.run(
        { label: "relay.tailscale.stack.apply", locks },
        Effect.promise(() =>
          harness.lifecycle.applyTailscaleStack(input, basis)
        )
      )
    )
    await applying.reached
    const deleted = deleting(harness, serverId)
    await vi.waitUntil(() =>
      harness.lanes
        .describe()
        .waiting.some(({ label }) => label === "tailscale.member.detach")
    )
    applying.release()
    await Promise.all([applied, deleted])

    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([])
    expect(
      JSON.parse(
        await readFile(
          join(harness.config.rootDirectory, stackId, "stack.json"),
          "utf8"
        )
      ).bindings
    ).toEqual([])
  })

  it("keeps a server at its Tailscale address when its container is recreated", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    fakeDocker.connect(container, network, address)

    // A port change recreates the server's container.
    await harness.lifecycle.updateInstancePorts(
      serverId,
      [
        {
          id: "primary",
          internalPort: 25_566,
          name: "Default Server",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(
      fakeDocker.container(container)?.networks.get(network)
    ).toMatchObject({
      ipAddress: address,
    })
  })

  it("keeps an apply that finds its member already attached by the time it connects it", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    await installedStack(harness)
    const connect = fakeDocker.hold({
      command: "network connect",
      target: network,
    })

    const applied = harness.lifecycle.applyTailscaleStack(
      relayTailscaleStackApplySchema.parse({
        bindings: [{ hostname: "paper", memberId: `instance:${serverId}` }],
        domain: "test",
        hostname: "private-network",
        id: stackId,
        name: "Private Network",
      })
    )
    await connect.reached
    // The server's start puts it there first.
    fakeDocker.connect(container, network, address)
    connect.release()

    await expect(applied).resolves.toBeDefined()
    expect(
      fakeDocker.container(container)!.networks.get(network)
    ).toMatchObject({ ipAddress: address })
    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([
      { address, memberId: `instance:${serverId}`, network },
    ])
  })

  it("applies a network beside a member being deleted that it leaves as it is, and leaves it alone", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    await installedStack(harness)
    await harness.freezes.freeze(
      { deletionId: "d".repeat(36), id: serverId, kind: "instance" },
      async () => {}
    )
    const input = relayTailscaleStackApplySchema.parse({
      bindings: [{ hostname: "paper", memberId: `instance:${serverId}` }],
      domain: "test",
      hostname: "private-network",
      id: stackId,
      name: "Private Network",
    })

    // As the control socket admits it, its locks planned from the stack.
    let basis: string | undefined
    const applied = await Effect.runPromise(
      harness.lanes.run(
        {
          label: "relay.tailscale.stack.apply",
          locks: await controlRequestLocks(
            "relay.tailscale.stack.apply",
            input,
            (reference) => reference,
            () => [],
            async (id) => {
              const plan = await harness.lifecycle.tailscaleStackPlan(id)
              basis = plan.basis
              return plan.bindings
            },
            (kind, id) => harness.lanes.isFrozen(kind, id)
          )!,
        },
        Effect.promise(() =>
          harness.lifecycle.applyTailscaleStack(input, basis)
        )
      )
    )

    expect(applied).toBeDefined()
    // Not joined to the network it was missing from, and still a member.
    expect(fakeDocker.container(container)!.networks.has(network)).toBe(false)
    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([
      { address, memberId: `instance:${serverId}`, network },
    ])
  })

  it("puts a crashed server back at its Tailscale address as recovery starts it", async () => {
    const harness = await relayHarness({
      KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0",
    })
    const { container, network } = await serverOnStack(harness, true)
    fakeDocker.exit(container, { exitCode: 1 })

    // Recovery schedules a start for the crash, then makes it.
    await harness.docker.inspectInstances()
    await harness.docker.inspectInstances()
    await vi.waitFor(() =>
      expect(fakeDocker.container(container)!.state.running).toBe(true)
    )

    expect(
      fakeDocker.container(container)!.networks.get(network)
    ).toMatchObject({ ipAddress: address })
  })

  it("puts a server back at its Tailscale address when it starts, if it lost it", async () => {
    const harness = await relayHarness()
    const { container, network } = await serverOnStack(harness)
    expect(fakeDocker.container(container)!.networks.has(network)).toBe(false)

    const instance = await harness.docker.findInstance(serverId)
    await harness.lifecycle.runInstanceAction(instance!, "start", [])

    expect(
      fakeDocker.container(container)!.networks.get(network)
    ).toMatchObject({ ipAddress: address })
  })
})

describe("Tailscale member identities", () => {
  const stackId = "c".repeat(40)
  const serverId = "a".repeat(40)
  const appMember = `app:${"b".repeat(40)}:web`

  async function savedStack(harness: RelayHarness, bindings: unknown) {
    const directory = join(harness.config.rootDirectory, stackId)
    await mkdir(directory, { recursive: true })
    const path = join(directory, "stack.json")
    await writeFile(
      path,
      JSON.stringify({
        bindings,
        domain: "test",
        hostname: "private-network",
        id: stackId,
        name: "Private Network",
        subnet: "10.165.57.0/24",
      })
    )
    return path
  }

  it("rewrites bindings saved with bare game server IDs as typed members, once", async () => {
    const harness = await relayHarness()
    const path = await savedStack(harness, [
      // As Relays before typed members saved them.
      {
        address: "10.165.57.10",
        enabled: true,
        hostname: "paper",
        instanceId: serverId,
      },
      {
        address: "10.165.57.11",
        enabled: false,
        hostname: "web",
        instanceId: appMember,
      },
    ])

    expect(await harness.lifecycle.migrateTailscaleStackMembers()).toBe(1)
    const rewritten = await readFile(path, "utf8")
    expect(JSON.parse(rewritten).bindings).toEqual([
      {
        address: "10.165.57.10",
        enabled: true,
        hostname: "paper",
        memberId: `instance:${serverId}`,
      },
      {
        address: "10.165.57.11",
        enabled: false,
        hostname: "web",
        memberId: appMember,
      },
    ])
    // A Relay restarted after it changes nothing more, and reads them.
    const restarted = await harness.restart()
    expect(await restarted.lifecycle.migrateTailscaleStackMembers()).toBe(0)
    expect(await readFile(path, "utf8")).toBe(rewritten)
    expect(await restarted.lifecycle.tailscaleMemberships(() => true)).toEqual([
      {
        address: "10.165.57.10",
        memberId: `instance:${serverId}`,
        network: harness.resources.tailscaleStackNetwork(stackId),
      },
    ])
  })

  describe("applying a stack", () => {
    const apply = (bindings: Array<{ hostname: string; memberId: string }>) =>
      relayTailscaleStackApplySchema.parse({
        bindings,
        domain: "test",
        hostname: "private-network",
        id: stackId,
        name: "Private Network",
      })

    // Runs work in the lanes as the control socket would, its locks planned
    // from the stack as saved.
    function inLane(
      harness: RelayHarness,
      operation: "instance.action" | "relay.tailscale.stack.apply",
      payload: Record<string, unknown>,
      run: () => Promise<unknown>,
      onPlanned = () => {}
    ) {
      return Effect.runPromise(
        harness.lanes.run(
          {
            label: operation,
            locks: controlRequestLocks(
              operation,
              payload,
              (reference) => reference,
              () => [],
              async (id) => {
                const { bindings } =
                  await harness.lifecycle.tailscaleStackPlan(id)
                onPlanned()
                return bindings
              }
            )!,
          },
          Effect.promise(run)
        )
      )
    }

    // Lets everything that can run now run.
    async function settle() {
      for (let turn = 0; turn < 20; turn += 1)
        await new Promise((resolve) => setImmediate(resolve))
    }

    async function stopping(harness: RelayHarness) {
      await harness.createServer({ id: serverId, start: true })
      const stop = fakeDocker.hold({ command: "stop" })
      const order: Array<string> = []
      const stopped = inLane(
        harness,
        "instance.action",
        { action: "stop", instanceId: serverId },
        async () => {
          await new DockerEngine(harness.config.dockerSocket)
            .stopContainer(harness.resources.instanceContainer(serverId))
            .pipe(Effect.runPromise)
          order.push("stopped")
        }
      )
      await stop.reached
      return { order, stop, stopped }
    }

    it("joins a game server only after its power change finishes", async () => {
      const harness = await relayHarness()
      await savedStack(harness, [])
      const { order, stop, stopped } = await stopping(harness)

      let planned!: () => void
      const plannedLocks = new Promise<void>((resolve) => {
        planned = resolve
      })
      const applied = inLane(
        harness,
        "relay.tailscale.stack.apply",
        apply([{ hostname: "paper", memberId: `instance:${serverId}` }]),
        async () => {
          order.push("applied")
        },
        () => planned()
      )
      await plannedLocks
      await settle()
      // It waits its turn while the server stops.
      expect(order).toEqual([])
      stop.release()

      await Promise.all([stopped, applied])
      expect(order).toEqual(["stopped", "applied"])
    })

    it("doesn't wait for the power changes of a member it leaves as it is", async () => {
      const harness = await relayHarness()
      await savedStack(harness, [
        {
          address: "10.165.57.10",
          enabled: true,
          hostname: "paper",
          memberId: `instance:${serverId}`,
        },
      ])
      const { order, stop, stopped } = await stopping(harness)

      await inLane(
        harness,
        "relay.tailscale.stack.apply",
        apply([
          { hostname: "paper", memberId: `instance:${serverId}` },
          { hostname: "web", memberId: appMember },
        ]),
        async () => {
          order.push("applied")
        }
      )
      stop.release()
      await stopped

      expect(order).toEqual(["applied", "stopped"])
    })

    it("refuses a change planned from members the stack no longer has", async () => {
      const harness = await relayHarness()
      await savedStack(harness, [])
      const planned = (await harness.lifecycle.tailscaleStackPlan(stackId))
        .basis
      // Another change to the stack ran meanwhile.
      await savedStack(harness, [
        {
          address: "10.165.57.10",
          enabled: true,
          hostname: "paper",
          memberId: `instance:${serverId}`,
        },
      ])

      await expect(
        harness.lifecycle.applyTailscaleStack(apply([]), planned)
      ).rejects.toThrow("changed while the change waited its turn")
    })
  })
})

describe("Tailscale databases", () => {
  const stackId = "c".repeat(40)
  const databaseId = "d".repeat(40)
  const address = "10.165.57.10"
  const member = `database:${databaseId}`

  async function databaseOnStack(harness: RelayHarness) {
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
    const network = harness.resources.tailscaleStackNetwork(stackId)
    fakeDocker.addNetwork({
      labels: owner,
      name: network,
      subnet: "10.165.57.0/24",
    })
    const directory = join(harness.config.rootDirectory, stackId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "stack.json"),
      JSON.stringify(
        stackConfig(stackId, {
          bindings: [
            { address, enabled: true, hostname: "orders", memberId: member },
          ],
          subnet: "10.165.57.0/24",
        })
      )
    )
    const container = `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
    fakeDocker.connect(container, network, address)
    return { container, network }
  }

  it("keeps a database at its Tailscale address when its container is replaced", async () => {
    const harness = await relayHarness()
    const { container, network } = await databaseOnStack(harness)
    const original = fakeDocker.container(container)!.id
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: 512 * 1024 ** 2 },
    })

    // Removing the limit replaces the container.
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: null },
    })

    const replacement = fakeDocker.container(container)!
    expect(replacement.id).not.toBe(original)
    expect(replacement.networks.get(network)).toMatchObject({
      ipAddress: address,
    })
  })

  it("puts a database back at its Tailscale address when the Relay starts, if it lost it meanwhile", async () => {
    const harness = await relayHarness()
    const { container, network } = await databaseOnStack(harness)
    // Taken off behind the Relay's back, as a crash between replacing its
    // container and reattaching it leaves it.
    await Effect.runPromise(
      new DockerEngine(harness.config.dockerSocket).disconnectNetwork(
        network,
        container
      )
    )
    expect(fakeDocker.container(container)!.networks.has(network)).toBe(false)

    const restarted = await harness.restart()
    await restarted.lifecycle.reattachTailscaleMembers(() => true)

    expect(
      fakeDocker.container(container)!.networks.get(network)
    ).toMatchObject({ ipAddress: address })
  })

  it("puts a replaced database back at its Tailscale address when it restarts, if taking it failed", async () => {
    const harness = await relayHarness()
    const { container, network } = await databaseOnStack(harness)
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: 512 * 1024 ** 2 },
    })
    // The old container is gone by the time the new one takes its address,
    // so nothing is left to recover from when that fails.
    fakeDocker.failNext(
      { command: "network connect", target: network },
      "Network unavailable"
    )
    await harness.databases.setLimits({
      databaseId,
      limits: { memoryBytes: null },
    })
    expect(fakeDocker.container(container)!.networks.has(network)).toBe(false)

    await harness.databases.action({ action: "restart", databaseId })

    expect(
      fakeDocker.container(container)!.networks.get(network)
    ).toMatchObject({ ipAddress: address })
  })

  it("takes a deleted database off its networks once Hearth has prepared their DNS", async () => {
    const harness = await relayHarness()
    const { container, network } = await databaseOnStack(harness)
    stackContainer(harness, stackId, true)
    const steps: Array<string> = []

    await harness.lifecycle.detachFromTailscale(
      (memberId) => memberId === member,
      async ({ memberId, mode, stackIds }) => {
        steps.push(
          `${mode} ${memberId} ${stackIds.join(",")} attached=${fakeDocker.container(container)!.networks.has(network)}`
        )
      }
    )

    expect(steps).toEqual([`prepare ${member} ${stackId} attached=true`])
    expect(fakeDocker.container(container)!.networks.has(network)).toBe(false)
    expect(await harness.lifecycle.tailscaleMemberships(() => true)).toEqual([])
  })
})
