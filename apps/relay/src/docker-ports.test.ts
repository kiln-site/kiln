import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

const commandMock = vi.hoisted(() => vi.fn())

vi.mock("./command.js", () => ({
  command: commandMock,
  commandEffect: vi.fn(),
}))

import {
  containerPortListening,
  dockerPublishedHostPorts,
  dockerPublishedHostPortsFromListing,
  dockerPublishedPort,
  dockerPublishedPrimaryPort,
  instanceConnectAddress,
  instancePublicHost,
  normalizedBrickNetworkMode,
  procNetTcpHasListener,
  publicConnectAddress,
} from "./docker.js"

describe("Docker public game ports", () => {
  it("normalizes legacy Minecraft proxy instances as Minecraft backends", () => {
    expect(normalizedBrickNetworkMode("minecraft-proxy")).toBe(
      "minecraft-backend"
    )
    expect(normalizedBrickNetworkMode("minecraft-backend")).toBe(
      "minecraft-backend"
    )
    expect(normalizedBrickNetworkMode("direct")).toBe("direct")
    expect(normalizedBrickNetworkMode("unknown")).toBeUndefined()
  })

  it("discovers Docker's assigned primary host port", () => {
    expect(
      dockerPublishedPort(
        {
          "25565/tcp": [
            { HostIp: "0.0.0.0", HostPort: "49172" },
            { HostIp: "::", HostPort: "49172" },
          ],
        },
        25_565,
        "tcp"
      )
    ).toBe(49_172)
  })

  it("ignores missing and invalid bindings", () => {
    expect(dockerPublishedPort({}, 25_565, "tcp")).toBeUndefined()
    expect(
      dockerPublishedPort(
        { "25565/tcp": [{ HostPort: "not-a-port" }] },
        25_565,
        "tcp"
      )
    ).toBeUndefined()
  })

  it("recovers the protocol from an unambiguous legacy binding", () => {
    expect(
      dockerPublishedPrimaryPort(
        {
          "25565/tcp": [
            { HostIp: "0.0.0.0", HostPort: "30000" },
            { HostIp: "::", HostPort: "30000" },
          ],
        },
        25_565,
        undefined
      )
    ).toEqual({ port: 30_000, protocol: "tcp" })
    expect(
      dockerPublishedPrimaryPort(
        {
          "25565/tcp": [{ HostPort: "30000" }],
          "25565/udp": [{ HostPort: "30001" }],
        },
        25_565,
        undefined
      )
    ).toBeUndefined()
    expect(
      dockerPublishedPrimaryPort(
        {
          "19132/tcp": [{ HostPort: "30132" }],
          "19132/udp": [{ HostPort: "30132" }],
        },
        19_132,
        undefined
      )
    ).toEqual({ port: 30_132, protocol: "both" })
  })

  it("collects host ports for the requested protocol across all bindings", () => {
    const bindings = {
      "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "30001" }],
      "25565/tcp": [
        { HostIp: "0.0.0.0", HostPort: "30000" },
        { HostIp: "::", HostPort: "30000" },
      ],
      "8080/tcp": [{ HostPort: "not-a-port" }],
    }

    expect([...dockerPublishedHostPorts(bindings, "tcp")]).toEqual([30_000])
    expect([...dockerPublishedHostPorts(bindings, "udp")]).toEqual([30_001])
  })

  it("collects published ports from Docker's compact container listing", () => {
    const listing = [
      "0.0.0.0:30000->25565/tcp, [::]:30000->25565/tcp",
      "127.0.0.1:30001-30003->19132-19134/udp",
      "8080/tcp, 9000/udp",
      "",
    ].join("\n")

    expect([...dockerPublishedHostPortsFromListing(listing, "tcp")]).toEqual([
      30_000,
    ])
    expect([...dockerPublishedHostPortsFromListing(listing, "udp")]).toEqual([
      30_001, 30_002, 30_003,
    ])
  })

  it("scales with compact port bindings instead of container metadata", () => {
    const listing = Array.from(
      { length: 5_000 },
      (_, index) => `0.0.0.0:${30_000 + (index % 1_000)}->25565/tcp`
    ).join("\n")

    const ports = dockerPublishedHostPortsFromListing(listing, "tcp")

    expect(ports.size).toBe(1_000)
    expect(ports.has(30_000)).toBe(true)
    expect(ports.has(30_999)).toBe(true)
  })

  it("formats IPv4, hostnames, and IPv6 connect addresses", () => {
    expect(publicConnectAddress("relay.example.com", 49_172)).toBe(
      "relay.example.com:49172"
    )
    expect(publicConnectAddress("203.0.113.5", 49_172)).toBe(
      "203.0.113.5:49172"
    )
    expect(publicConnectAddress("2001:db8::5", 49_172)).toBe(
      "[2001:db8::5]:49172"
    )
  })

  it("resolves game addresses without the legacy generated hostname", () => {
    expect(
      instanceConnectAddress({
        gameHost: "games.example.com",
        publicPort: 49_172,
        relayHost: "relay.example.com",
      })
    ).toBe("games.example.com:49172")
    expect(
      instanceConnectAddress({
        discoveredPublicIp: "203.0.113.5",
        publicPort: 49_172,
        relayHost: "relay.example.com",
      })
    ).toBe("203.0.113.5:49172")
    expect(
      instanceConnectAddress({
        publicPort: 49_172,
        relayHost: "relay.example.com",
      })
    ).toBe("relay.example.com:49172")
  })

  it("uses the Relay's live game host ahead of a stale container label", () => {
    expect(
      instancePublicHost({
        discoveredPublicIp: "203.0.113.5",
        gameHost: "203.0.113.6",
        instanceHost: "203.0.113.4",
        relayHost: "relay.example.com",
      })
    ).toBe("203.0.113.6")
  })

  it("always prefers Tailscale and reports an unavailable endpoint", () => {
    expect(
      instanceConnectAddress({
        gameHost: "games.example.com",
        publicPort: 49_172,
        relayHost: "relay.example.com",
        tailscaleHost: "paper.kiln.test",
      })
    ).toBe("paper.kiln.test")
    expect(instanceConnectAddress({})).toBe(
      "Error: Relay did not report a published game port"
    )
    expect(instanceConnectAddress({ relayHost: "relay.example.com" })).toBe(
      "Error: Relay did not report a published game port"
    )
  })
})

describe("container port readiness", () => {
  beforeEach(() => {
    commandMock.mockReset()
  })

  it("recognizes listening IPv4 and IPv6 sockets", () => {
    const procNetTcp = [
      "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt",
      "0: 00000000:63DD 00000000:0000 0A 00000000:00000000",
      "1: 00000000000000000000000000000000:9C40 00000000000000000000000000000000:0000 0A 00000000:00000000",
    ].join("\n")

    expect(procNetTcpHasListener(procNetTcp, 25_565)).toBe(true)
    expect(procNetTcpHasListener(procNetTcp, 40_000)).toBe(true)
    expect(procNetTcpHasListener(procNetTcp, 25_566)).toBe(false)
  })

  it("ignores connected sockets on the target port", () => {
    expect(
      procNetTcpHasListener(
        "0: 0100007F:63DD 0100007F:C001 01 00000000:00000000",
        25_565
      )
    ).toBe(false)
  })

  it("accepts an IPv4 listener without requiring /proc/net/tcp6", async () => {
    commandMock.mockResolvedValueOnce({
      stderr: "",
      stdout: "0: 00000000:63DD 00000000:0000 0A 00000000:00000000",
    })

    await expect(containerPortListening("container-id", 25_565)).resolves.toBe(
      true
    )
    expect(commandMock).toHaveBeenCalledOnce()
    expect(commandMock).toHaveBeenCalledWith(
      "docker",
      ["exec", "container-id", "cat", "/proc/net/tcp"],
      { timeout: 2_000 }
    )
  })

  it("returns an IPv4 result when /proc/net/tcp6 is absent", async () => {
    commandMock
      .mockResolvedValueOnce({
        stderr: "",
        stdout:
          "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt",
      })
      .mockRejectedValueOnce(new Error("/proc/net/tcp6 is absent"))

    await expect(containerPortListening("container-id", 25_565)).resolves.toBe(
      false
    )
  })
})
