import { Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const first = "a".repeat(40)
const second = "b".repeat(40)

function serverContainer(harness: RelayHarness, id: string) {
  const container = fakeDocker.container(harness.resources.instanceContainer(id))
  if (!container) throw new Error(`Server ${id} has no container`)
  return container
}

async function serverConfig(harness: RelayHarness, id: string) {
  const instance = await harness.docker.findInstance(id)
  if (!instance) throw new Error(`Server ${id} was not discovered`)
  return instance
}

/** A foreign, non-Kiln container publishing `port` on the host. */
function occupyHostPort(port: number, protocol: "tcp" | "udp") {
  return fakeDocker.addContainer({
    name: `voice-${port}-${protocol}`,
    portBindings: {
      [`${port}/${protocol}`]: [{ HostIp: "", HostPort: String(port) }],
    },
    running: true,
  })
}

describe("instance port lifecycle", () => {
  it("assigns each new server a free public port until the range is exhausted", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32123-32124",
    })

    const one = await harness.createServer({ id: first })
    const two = await harness.createServer({ id: second })

    expect(
      new Set([one.publicPort, two.publicPort])
    ).toEqual(new Set([32_123, 32_124]))
    expect(serverContainer(harness, first).portBindings).toEqual({
      "25565/tcp": [{ HostIp: "", HostPort: String(one.publicPort) }],
    })
    await expect(
      harness.createServer({ id: "c".repeat(40) })
    ).rejects.toThrow("No game ports are available")
    expect(
      fakeDocker.container(harness.resources.instanceContainer("c".repeat(40)))
    ).toBeUndefined()
  })

  it("bootstraps a missing primary allocation on a legacy server", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
    })
    await harness.seedServer({ id: first })

    const updated = await harness.lifecycle.updateInstancePorts(
      first,
      [
        {
          id: "primary",
          internalPort: 25_570,
          name: "Ignored client name",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(updated.ports).toEqual([
      {
        externalPort: 32_123,
        id: "primary",
        internalPort: 25_570,
        kind: "primary",
        name: "Default Server",
        protocol: "tcp",
      },
    ])
    const container = serverContainer(harness, first)
    expect(container.portBindings).toEqual({
      "25570/tcp": [{ HostIp: "", HostPort: "32123" }],
    })
    expect(container.labels["kiln.brick.primary-port"]).toBe("25570/tcp")
    expect(container.state.running).toBe(false)
    // The replacement keeps the server's data mount and leaves no backup.
    expect(container.mounts).toEqual([
      expect.objectContaining({ destination: "/server", type: "bind" }),
    ])
    expect(fakeDocker.containers.size).toBe(1)
  })

  it("adds a protocol to an existing allocation only when its host binding is free", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
    })
    await harness.createServer({ id: first })
    const voice = occupyHostPort(32_123, "udp")
    const before = structuredClone(serverContainer(harness, first).portBindings)
    const both = [
      {
        id: "primary",
        internalPort: 25_565,
        name: "Default Server",
        protocol: "both" as const,
      },
    ]

    await expect(
      harness.lifecycle.updateInstancePorts(first, both, [])
    ).rejects.toThrow("already in use")
    expect(serverContainer(harness, first).portBindings).toEqual(before)

    fakeDocker.removeContainer(voice.name)
    const updated = await harness.lifecycle.updateInstancePorts(first, both, [])

    expect(updated.ports).toMatchObject([
      { externalPort: 32_123, id: "primary", protocol: "both" },
    ])
    expect(serverContainer(harness, first).portBindings).toEqual({
      "25565/tcp": [{ HostIp: "", HostPort: "32123" }],
      "25565/udp": [{ HostIp: "", HostPort: "32123" }],
    })
  })

  it("moves a primary allocation to a leased port while adding a protocol", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
    })
    await harness.createServer({ id: first })
    harness.config.gamePortRange = { end: 32_124, start: 32_124 }
    // The old port's UDP side is taken; only the new port must be free.
    occupyHostPort(32_123, "udp")

    const lease = await Effect.runPromise(
      harness.lifecycle.reserveInstancePortEffect(first, {
        externalPort: 32_124,
        protocol: "both",
      })
    )
    const updated = await harness.lifecycle.updateInstancePorts(
      first,
      [
        {
          externalPort: lease.externalPort,
          id: "primary",
          internalPort: 25_565,
          leaseId: lease.id,
          name: "Default Server",
          protocol: "both",
        },
      ],
      []
    )

    expect(updated.publicPort).toBe(32_124)
    expect(serverContainer(harness, first).portBindings).toEqual({
      "25565/tcp": [{ HostIp: "", HostPort: "32124" }],
      "25565/udp": [{ HostIp: "", HostPort: "32124" }],
    })
  })

  it("allows an explicit public port outside the configured range only with an override", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
    })
    await harness.seedServer({ id: first })

    const denied = await Effect.runPromiseExit(
      harness.lifecycle.reserveInstancePortEffect(first, {
        externalPort: 8_211,
        protocol: "tcp",
      })
    )
    const lease = await Effect.runPromise(
      harness.lifecycle.reserveInstancePortEffect(first, {
        externalPort: 8_211,
        overridePortRange: true,
        protocol: "tcp",
      })
    )

    expect(Exit.isFailure(denied)).toBe(true)
    expect(lease.externalPort).toBe(8_211)
  })

  it("expires abandoned leases, enforces lease ownership, and lets one concurrent reservation win", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-07-30T12:00:00.000Z"), toFake: ["Date"] })
    try {
      const harness = await relayHarness({
        KILN_RELAY_GAME_PORT_RANGE: "32125-32125",
      })
      await harness.seedServer({ id: first })
      await harness.seedServer({ id: second })
      const reserve = (instanceId: string, leaseId?: string, externalPort?: number) =>
        Effect.runPromiseExit(
          harness.lifecycle.reserveInstancePortEffect(instanceId, {
            externalPort,
            leaseId,
            protocol: "tcp",
          })
        )
      const release = (instanceId: string, leaseId: string) =>
        Effect.runPromiseExit(
          harness.lifecycle.releaseInstancePortEffect(instanceId, leaseId)
        )
      const lease = (exit: Exit.Exit<{ externalPort: number; id: string }, unknown>) => {
        if (Exit.isFailure(exit)) throw new Error("Expected a port lease")
        return exit.value
      }
      const failureCode = (exit: Exit.Exit<unknown, { code: string }>) =>
        Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error.code
          : undefined

      const abandoned = lease(await reserve(first))
      expect(abandoned.externalPort).toBe(32_125)
      // A failed renewal must not release the port it already holds.
      expect(failureCode(await reserve(first, abandoned.id, 32_126))).toBe(
        "allocation_failed"
      )
      expect(Exit.isFailure(await reserve(second))).toBe(true)

      vi.setSystemTime(Date.parse("2026-07-30T12:02:00.001Z"))
      const reclaimed = lease(await reserve(second))
      expect(reclaimed.externalPort).toBe(32_125)

      expect(Exit.isSuccess(await release(second, reclaimed.id))).toBe(true)
      const released = lease(await reserve(first))
      expect(released.externalPort).toBe(32_125)
      expect(failureCode(await release(second, released.id))).toBe(
        "lease_owner_mismatch"
      )
      expect(Exit.isSuccess(await release(first, released.id))).toBe(true)

      const outcomes = await Promise.all([reserve(first), reserve(second)])
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stages a missing primary port and applies it on the next restart", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
    })
    await harness.seedServer({ id: first, running: true })
    const occupant = occupyHostPort(32_124, "tcp")

    const staged = await harness.lifecycle.updateInstancePorts(
      first,
      [
        {
          id: "primary",
          internalPort: 24_454,
          name: "Ignored client name",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(staged.pendingPrimaryPort).toEqual({
      id: "primary",
      internalPort: 24_454,
      name: "Default Server",
      protocol: "tcp",
    })
    expect(staged.ports).toEqual([])
    expect(serverContainer(harness, first).portBindings).toEqual({})

    fakeDocker.removeContainer(occupant.name)
    const updated = await harness.lifecycle.runInstanceAction(
      await serverConfig(harness, first),
      "restart",
      [],
      staged.pendingPrimaryPort
    )

    expect(updated.publicPort).toBe(32_124)
    const container = serverContainer(harness, first)
    expect(container.portBindings).toEqual({
      "24454/tcp": [{ HostIp: "", HostPort: "32124" }],
    })
    expect(container.state.running).toBe(true)
  })
})
