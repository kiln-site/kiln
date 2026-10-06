import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const id = "a".repeat(40)

const publishedServer = (
  harness: RelayHarness,
  overrides: Parameters<RelayHarness["seedServer"]>[0] = { id }
) =>
  harness.seedServer({
    portBindings: { "25565/tcp": [{ HostIp: "", HostPort: "49172" }] },
    ...overrides,
    labels: { "kiln.brick.primary-port": "25565/tcp", ...overrides.labels },
  })

async function discovered(harness: RelayHarness) {
  const [instance] = await harness.docker.inspectInstances()
  if (!instance) throw new Error("No server was discovered")
  return instance
}

describe("server connect addresses", () => {
  it.each([
    ["games.example.com", "games.example.com:49172"],
    ["203.0.113.5", "203.0.113.5:49172"],
    ["2001:db8::5", "[2001:db8::5]:49172"],
  ])("publishes the game host %s with the assigned port", async (host, address) => {
    const harness = await relayHarness({ KILN_RELAY_GAME_HOST: host })
    await publishedServer(harness)

    expect(await discovered(harness)).toMatchObject({
      connectAddress: address,
      publicPort: 49_172,
    })
  })

  it("uses the Relay's live game host ahead of a stale container label", async () => {
    const harness = await relayHarness({ KILN_RELAY_GAME_HOST: "203.0.113.6" })
    await publishedServer(harness, {
      id,
      labels: { "kiln.instance.public-host": "203.0.113.4" },
    })

    expect(await discovered(harness)).toMatchObject({
      connectAddress: "203.0.113.6:49172",
      publicHost: "203.0.113.6",
    })
  })

  it("prefers the Tailscale hostname when Tailscale is enabled", async () => {
    const harness = await relayHarness({ KILN_RELAY_GAME_HOST: "games.example.com" })
    await publishedServer(harness, {
      id,
      labels: {
        "kiln.instance.hostname": "paper.kiln.test",
        "kiln.instance.tailscale-enabled": "true",
        "kiln.instance.tailscale-subdomain": "paper",
      },
    })

    expect((await discovered(harness)).connectAddress).toBe("paper.kiln.test")
  })

  it("reports no public port for a server without a published primary port", async () => {
    const harness = await relayHarness({ KILN_RELAY_GAME_HOST: "games.example.com" })
    await harness.seedServer({ id })

    const instance = await discovered(harness)

    expect(instance.publicPort).toBeUndefined()
    expect(instance.connectAddress).not.toContain("games.example.com")
  })

  it("recovers legacy Minecraft proxy servers as Minecraft backends", async () => {
    const harness = await relayHarness()
    await publishedServer(harness, {
      id,
      labels: { "kiln.brick.network-mode": "minecraft-proxy" },
    })

    expect((await discovered(harness)).brickNetworkMode).toBe("minecraft-backend")
  })
})

describe("host port usage", () => {
  it("reports host ports other containers publish in a range", async () => {
    const harness = await relayHarness()
    fakeDocker.addContainer({
      name: "voice",
      portBindings: { "30001/udp": [{ HostIp: "", HostPort: "30001" }] },
      running: true,
    })
    fakeDocker.addContainer({
      name: "stopped",
      portBindings: { "30002/udp": [{ HostIp: "", HostPort: "30002" }] },
    })

    const ports = await harness.docker.publishedHostPorts("udp", {
      end: 30_010,
      start: 30_000,
    })

    expect([...ports]).toEqual([30_001])
  })
})

describe("container port readiness", () => {
  it.each([
    { listening: true, observedState: "running" },
    { listening: false, observedState: "starting" },
  ])(
    "treats a freshly started server as ready only once its game port listens (listening=$listening)",
    async ({ listening, observedState }) => {
      const harness = await relayHarness()
      await publishedServer(harness, {
        id,
        listeningPorts: listening ? [25_565] : [],
        running: true,
      })

      expect((await discovered(harness)).observedState).toBe(observedState)
    }
  )
})
