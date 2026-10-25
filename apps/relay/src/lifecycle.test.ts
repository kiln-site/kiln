import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { relayOwnerLabels } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const settings = {
  acmeEmail: "admin@example.com",
  mode: "traefik" as const,
  traefikImage: "traefik:v3.7.13",
}

describe("proxy settings hydration", () => {
  it("hydrates the trusted Coolify edge without advertising private port 4100", async () => {
    const harness = await relayHarness({
      KILN_RELAY_HOST: "",
      KILN_RELAY_PROXY: "coolify",
      NODE_ENV: "production",
      SERVICE_URL_KILN_RELAY_4100: "https://relay.example.com",
    })

    harness.lifecycle.hydrateProxySettings({ ...settings, mode: "coolify" })

    expect(harness.config.publicPort).toBe(443)
    expect(harness.config.browserOrigin).toBe("https://relay.example.com")
  })

  it("restores the direct endpoint when bundled Traefik is disabled", async () => {
    const harness = await relayHarness({
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })

    harness.lifecycle.hydrateProxySettings({ ...settings, mode: "none" })
    expect(harness.config.publicPort).toBe(4100)
    expect(harness.config.browserOrigin).toBe("http://relay.example.com:4100")

    harness.lifecycle.hydrateProxySettings(settings)
    expect(harness.config.publicPort).toBe(443)
    expect(harness.config.browserOrigin).toBe("https://relay.example.com")
  })
})

describe("Hearth behind bundled Traefik in platform mode", () => {
  const hearthSettings = { ...settings, mode: "hearth" as const }

  async function platformHarness() {
    const harness = await relayHarness()
    harness.config.platformEdge = {
      host: "203.0.113.10",
      network: "kiln-platform",
      upstream: "http://kiln-hearth:3000",
    }
    fakeDocker.addContainer({ name: "kiln-relay", running: true })
    fakeDocker.addNetwork({ name: "kiln-platform" })
    vi.stubEnv("HOSTNAME", "kiln-relay")
    return harness
  }

  it("starts Traefik on a later pass after its ports were busy", async () => {
    const harness = await platformHarness()
    const traefik = harness.resources.traefikContainer
    fakeDocker.failNext(
      { command: "start" },
      "Bind for 0.0.0.0:443 failed: port is already allocated"
    )

    await harness.lifecycle.initializeProxy([], hearthSettings)
    expect(fakeDocker.container(traefik)?.state.running ?? false).toBe(false)

    await harness.lifecycle.reconcilePlatformEdge()

    const container = fakeDocker.container(traefik)
    expect(container?.state.running).toBe(true)
    expect([...container!.networks.keys()]).toContain("kiln-platform")
  })

  // A stack from Kiln's old compose.yaml: its Relay and the Traefik it runs,
  // from that Relay's own data, in this Relay's resource namespace.
  const theirData = "/var/lib/docker/volumes/kiln_relay-data/_data"
  const theirs = {
    destination: "/etc/traefik/traefik.yaml",
    readOnly: true,
    source: `${theirData}/infrastructure/traefik.yaml`,
    type: "bind" as const,
  }
  function legacyStack(
    harness: Awaited<ReturnType<typeof platformHarness>>,
    relayRunning: boolean
  ) {
    fakeDocker.addContainer({
      mounts: [{ destination: "/data", source: theirData, type: "bind" }],
      name: "kiln-relay-1",
      running: relayRunning,
    })
    fakeDocker.addContainer({
      image: "traefik:v3.7.13",
      labels: relayOwnerLabels(harness.config),
      mounts: [theirs],
      name: harness.resources.traefikContainer,
      running: true,
    })
  }

  it("leaves another running Relay's Traefik alone", async () => {
    const harness = await platformHarness()
    legacyStack(harness, true)

    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    await harness.lifecycle.initializeProxy([], hearthSettings)

    // Hearth stays at its own port, and the log says why.
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        "running for another Relay on this host, kiln-relay-1"
      )
    )
    const container = fakeDocker.container(harness.resources.traefikContainer)
    expect(container?.state.running).toBe(true)
    expect(container?.mounts).toContainEqual(theirs)
  })

  it("leaves a running Traefik alone when it can't tell whose it is", async () => {
    const harness = await platformHarness()
    legacyStack(harness, false)
    fakeDocker.failNext(
      { command: "ps", target: JSON.stringify({ status: ["running"] }) },
      "Docker is unavailable"
    )

    vi.spyOn(console, "error").mockImplementation(() => {})
    await harness.lifecycle.initializeProxy([], hearthSettings)

    const container = fakeDocker.container(harness.resources.traefikContainer)
    expect(container?.state.running).toBe(true)
    expect(container?.mounts).toContainEqual(theirs)
  })

  it("takes over the Traefik a stopped Relay left running", async () => {
    const harness = await platformHarness()
    // Moving that install under this Relay: its Relay stopped first.
    legacyStack(harness, false)

    await harness.lifecycle.initializeProxy([], hearthSettings)

    const container = fakeDocker.container(harness.resources.traefikContainer)
    expect(container?.state.running).toBe(true)
    expect(container?.mounts).not.toContainEqual(theirs)
  })

  it("moves Traefik to the image Hearth's proxy settings name", async () => {
    const harness = await platformHarness()
    await harness.lifecycle.initializeProxy([], hearthSettings)

    await harness.lifecycle.configureProxy(
      { ...hearthSettings, traefikImage: "traefik:v3.7.14" },
      []
    )

    const container = fakeDocker.container(harness.resources.traefikContainer)
    expect(container?.image).toBe("traefik:v3.7.14")
    expect(container?.state.running).toBe(true)
  })
})
