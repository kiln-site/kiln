import { relayInstanceWebRoutesSchema } from "@workspace/contracts"
import { parse } from "yaml"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { loadConfig } from "./config.js"
import { type ContainerSeed, fakeDocker } from "./test/docker.js"
import {
  discoverExternalTraefikContainer,
  recoveryRouteLabels,
  routeLabelsRequireRestart,
  traefikDynamicConfiguration,
  traefikRouteLabels,
  traefikStaticConfiguration,
} from "./traefik.js"

const settings = {
  acmeEmail: "admin@example.com",
  mode: "traefik" as const,
  traefikImage: "traefik:v3.7.13",
}
const route = {
  hostname: "donutsmp.example.com",
  id: "b00d4423",
  instanceId: "a".repeat(40),
  name: "Live Map",
  path: "/map",
  stripPrefix: true,
  targetPort: 8080,
}
const coolify = {
  certificateResolver: "letsencrypt",
  httpEntryPoint: "http",
  httpsEntryPoint: "https",
}

interface DynamicConfiguration {
  http: {
    middlewares: Record<string, Record<string, unknown>>
    routers: Record<
      string,
      { middlewares?: Array<string>; rule: string; service: string }
    >
    services: Record<
      string,
      { loadBalancer: { servers: Array<{ url: string }> } }
    >
  }
}

function dynamicConfiguration(environment: Record<string, string> = {}) {
  return parse(
    traefikDynamicConfiguration(
      loadConfig({
        KILN_RELAY_HOST: "relay.example.com",
        KILN_RELAY_PROXY: "traefik",
        NODE_ENV: "development",
        ...environment,
      }),
      [route],
      settings
    )
  ) as DynamicConfiguration
}

describe("bundled Traefik configuration", () => {
  it("obtains certificates over HTTP-01 without access to the Docker socket", () => {
    const configuration = parse(traefikStaticConfiguration(settings)) as {
      certificatesResolvers: { kiln: { acme: Record<string, unknown> } }
      providers: Record<string, unknown>
    }

    expect(configuration.certificatesResolvers.kiln.acme).toMatchObject({
      email: "admin@example.com",
      httpChallenge: { entryPoint: "web" },
    })
    expect(Object.keys(configuration.providers)).toEqual(["file"])
  })

  it("routes the Relay and Ember routes, rate-limiting browser admission", () => {
    const { http } = dynamicConfiguration()
    const name = "kiln-route-b00d4423"

    expect(http.routers[name]).toMatchObject({
      middlewares: [`${name}-strip`],
      rule: "Host(`donutsmp.example.com`) && PathPrefix(`/map`)",
    })
    expect(http.services[name]?.loadBalancer.servers).toEqual([
      { url: "http://kiln-aaaaaaaa:8080" },
    ])
    expect(http.middlewares[`${name}-strip`]).toEqual({
      stripPrefix: { prefixes: ["/map"] },
    })
    expect(http.routers["kiln-relay-browser"]).toMatchObject({
      middlewares: ["kiln-relay-browser-admission"],
      rule: "Host(`relay.example.com`) && Path(`/v1/browser`)",
    })
    expect(http.middlewares["kiln-relay-browser-admission"]).toHaveProperty(
      "rateLimit"
    )
    expect(http.services["kiln-relay"]?.loadBalancer.servers).toEqual([
      { url: "http://kiln-relay:4100" },
    ])
  })

  it("targets namespaced Ember containers for an isolated Relay", () => {
    const { http } = dynamicConfiguration({
      KILN_RELAY_RESOURCE_NAMESPACE: "hearth-feature-a1b2c3",
    })

    expect(http.services["kiln-route-b00d4423"]?.loadBalancer.servers).toEqual([
      { url: "http://hearth-feature-a1b2c3-kiln-aaaaaaaa:8080" },
    ])
  })

  it("rejects paths that can escape a Traefik rule literal", () => {
    expect(() =>
      relayInstanceWebRoutesSchema.parse([
        { ...route, path: "/map`) || Host(`relay.example.com`)" },
      ])
    ).toThrow("routing metacharacters")
  })

  it.each(["/.", "/..", "/map/.", "/map/.."])(
    "rejects terminal dot-segment path %s",
    (path) => {
      expect(() =>
        relayInstanceWebRoutesSchema.parse([{ ...route, path }])
      ).toThrow()
    }
  )
})

describe("external Traefik labels", () => {
  it("exposes routed Embers to an external Traefik edge", () => {
    const labels = traefikRouteLabels([route], coolify)
    const name = "kiln-route-b00d4423"

    expect(labels).toMatchObject({
      "traefik.docker.network": "kiln-edge",
      "traefik.enable": "true",
      [`traefik.http.routers.${name}-https.entrypoints`]: "https",
      [`traefik.http.routers.${name}-https.rule`]:
        "Host(`donutsmp.example.com`) && PathPrefix(`/map`)",
      [`traefik.http.routers.${name}-https.tls.certresolver`]: "letsencrypt",
      [`traefik.http.services.${name}.loadbalancer.server.port`]: "8080",
    })
    expect(labels["kiln.relay.web-routes.revision"]).toMatch(/^[a-f0-9]{64}$/u)
  })

  it("stores recovery labels without exposing the Ember to Traefik", () => {
    const labels = recoveryRouteLabels([route])

    expect(labels["traefik.enable"]).toBe("false")
    expect(labels["traefik.docker.network"]).toBeUndefined()
    expect(labels["kiln.relay.web-routes.b00d4423"]).toBeDefined()
  })

  it("recreates an Ember only when its managed route labels change", () => {
    const withoutRoutes = traefikRouteLabels([], coolify)

    expect(
      routeLabelsRequireRestart({ "traefik.enable": "false" }, [], withoutRoutes)
    ).toBe(false)
    expect(
      routeLabelsRequireRestart(traefikRouteLabels([route], coolify), [], withoutRoutes)
    ).toBe(true)
    const routed = traefikRouteLabels([route], coolify)
    expect(routeLabelsRequireRestart(routed, [route], routed)).toBe(false)
  })
})

describe("external Traefik discovery", () => {
  afterEach(() => {
    fakeDocker.reset()
  })

  function traefik(name: string, overrides: Partial<ContainerSeed> = {}) {
    return fakeDocker.addContainer({
      image: "traefik:v3.7.13",
      name,
      running: true,
      ...overrides,
    })
  }

  it("only considers proxies attached to a namespaced Relay's own edge", async () => {
    const edge = "hearth-feature-a1b2c3-kiln-edge"
    fakeDocker.addNetwork({ name: edge })
    fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/ember:latest",
      name: "hearth-feature-a1b2c3-kiln-aaaaaaaa",
      networks: [edge],
      running: true,
    })
    traefik("host-traefik", {
      portBindings: { "443/tcp": [{ HostIp: "", HostPort: "443" }] },
    })
    traefik("manual-traefik", { networks: [edge] })

    for (const mode of ["none", "hearth", "traefik"] as const) {
      await expect(
        discoverExternalTraefikContainer({
          edgeNetwork: edge,
          resourceNamespace: "hearth-feature-a1b2c3",
          settings: { ...settings, mode },
        })
      ).resolves.toBe("manual-traefik")
    }
  })

  it("finds a host proxy publishing HTTPS for an unscoped Relay", async () => {
    fakeDocker.addContainer({
      name: "web",
      portBindings: { "443/tcp": [{ HostIp: "", HostPort: "8443" }] },
      running: true,
    })
    traefik("host-traefik", {
      portBindings: { "443/tcp": [{ HostIp: "", HostPort: "443" }] },
    })

    await expect(
      discoverExternalTraefikContainer({
        edgeNetwork: "kiln-edge",
        resourceNamespace: null,
        settings: { ...settings, mode: "none" },
      })
    ).resolves.toBe("host-traefik")
  })
})
