import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { appRouteOwner } from "./relay-resources.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const settings = {
  acmeEmail: "admin@example.com",
  mode: "traefik" as const,
  traefikImage: "traefik:v3.7.13",
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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

describe("edge recovery", () => {
  const appId = "c".repeat(40)
  const serverId = "a".repeat(40)
  const coolifySettings = { ...settings, mode: "coolify" as const }

  // The Relay's own container, which the fake can inspect.
  function relayContainer() {
    vi.stubEnv("HOSTNAME", "kiln-relay")
    return fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/relay:test",
      name: "kiln-relay",
      running: true,
    })
  }

  function appService(networks: Array<string> = []) {
    return fakeDocker.addContainer({
      labels: {
        "kiln.app.id": appId,
        "kiln.app.service": "app",
        "kiln.relay.owned": "true",
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "app",
      },
      name: `${TEST_NAMESPACE}-kiln-cccccccc-20261025000000`,
      networks,
      running: true,
    })
  }

  const route = (instanceId: string) => ({
    hostname: `${instanceId.slice(0, 8)}.example.com`,
    id: instanceId.slice(-8),
    instanceId,
    name: "Site",
    path: null,
    service: "app",
    stripPrefix: true,
    targetPort: 80,
  })

  it("puts bundled Traefik and the Relay back on the networks they lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const harness = await relayHarness({ KILN_RELAY_PROXY: "traefik" })
    const relay = relayContainer()
    await harness.apps.create({ id: appId, name: "Website" })
    const network = harness.resources.appNetwork(appId)
    const relayEdge = harness.resources.relayEdgeNetwork
    await harness.lifecycle.initializeProxy([], settings)
    const traefik = fakeDocker.container(harness.resources.traefikContainer)!
    await vi.waitFor(() =>
      expect([...traefik.networks.keys()]).toContain(network)
    )

    traefik.networks.delete(network)
    relay.networks.delete(relayEdge)
    await vi.advanceTimersByTimeAsync(30_000)

    await vi.waitFor(() => {
      expect([...traefik.networks.keys()]).toContain(network)
      expect(relay.networks.get(relayEdge)?.aliases).toContain("kiln-relay")
    })
    expect(traefik.starts).toBe(1)
  })

  it("reconnects routed services to a remade edge network, retrying until Coolify's Traefik reads them again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const harness = await relayHarness({
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "coolify",
    })
    const edge = harness.resources.edgeNetwork
    const refresh = harness.resources.traefikRefreshContainer
    relayContainer()
    const proxy = fakeDocker.addContainer({
      image: "traefik:v3.7",
      name: "coolify-proxy",
      running: true,
    })
    const app = appService()
    const server = await harness.seedServer({ id: serverId, running: true })
    await harness.lifecycle.initializeProxy(
      [route(appRouteOwner(appId)), route(serverId)],
      coolifySettings
    )
    fakeDocker.connect(app.name, edge)
    // Another Relay takes the edge network down, and it's made again.
    for (const container of [proxy, app, server]) {
      container.networks.delete(edge)
    }
    fakeDocker.networks.delete(edge)
    const errors = vi.spyOn(console, "error")
    fakeDocker.failNext({ command: "start" }, "no space left on device")
    const since = fakeDocker.events.length

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    expect(
      fakeDocker.events.slice(since).filter(({ action }) => action === "start")
    ).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)

    await vi.waitFor(() =>
      expect(fakeDocker.events.slice(since)).toContainEqual({
        action: "start",
        container: refresh,
      })
    )
    const events = fakeDocker.events.slice(since)
    const reconnected = events
      .slice(
        0,
        events.findIndex(({ container }) => container === refresh)
      )
      .filter(({ action, network }) => action === "connect" && network === edge)
      .map(({ container }) => container)
    expect(reconnected.sort()).toEqual(
      [app.name, proxy.name, server.name].sort()
    )
    expect([app.starts, server.starts]).toEqual([0, 0])
  })

  it("leaves the edge network and what's on it when no routes use it", async () => {
    const harness = await relayHarness({
      KILN_RELAY_HOST: "relay.example.com",
    })
    const edge = harness.resources.edgeNetwork
    fakeDocker.addNetwork({
      labels: {
        "kiln.relay.network": "edge",
        "kiln.relay.owner": TEST_NAMESPACE,
      },
      name: edge,
    })
    const app = appService([edge])

    // A Relay starting in another proxy mode, then one with no routes.
    await harness.lifecycle.initializeProxy([], { ...settings, mode: "hearth" })
    await harness.lifecycle.configureWebRoutes([], coolifySettings)

    expect(fakeDocker.networks.has(edge)).toBe(true)
    expect([...app.networks.keys()]).toContain(edge)
  })
})
