import { relayInstanceWebRoutesSchema } from "@workspace/contracts"
import { parse } from "yaml"
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test"

import { loadConfig } from "./config.js"
import { DockerEngine } from "./docker-engine.js"
import type { RelayStoredWebRoute } from "./effect/state.js"
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
const route: RelayStoredWebRoute = {
  hostname: "donutsmp.example.com",
  id: "b00d4423",
  instanceId: "a".repeat(40),
  name: "Live Map",
  path: "/map",
  stripPrefix: true,
  httpsRedirect: true,
  primary: false,
  redirect: null,
  www: "none" as const,
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
    const configuration = parse(
      traefikStaticConfiguration(settings, {
        advertisedHost: "relay.example.com",
        platformEdge: null,
        proxyMode: "traefik",
        traefikAcmeCaServer: null,
      })
    ) as {
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

  it("reaches a Relay at an IP address with that address's certificate", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "203.0.113.20",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })
    const dynamic = parse(
      traefikDynamicConfiguration(config, [route], settings)
    ) as DynamicConfiguration & {
      http: { routers: Record<string, { tls?: Record<string, unknown> }> }
      tls?: { stores: { default: { defaultGeneratedCert: unknown } } }
    }
    const ipCertificate = {
      certResolver: "kiln-ip",
      domains: [{ main: "203.0.113.20" }],
    }

    expect(dynamic.http.routers["kiln-relay"]?.tls).toEqual(ipCertificate)
    expect(dynamic.http.routers["kiln-relay-browser"]?.tls).toEqual(
      ipCertificate
    )
    expect(dynamic.tls?.stores.default.defaultGeneratedCert).toEqual({
      domain: { main: "203.0.113.20" },
      resolver: "kiln-ip",
    })
    // Ember routes have names of their own.
    expect(dynamic.http.routers["kiln-route-b00d4423"]?.tls).toEqual({
      certResolver: "kiln",
    })
    const resolvers = (
      parse(traefikStaticConfiguration(settings, config)) as {
        certificatesResolvers: Record<string, { acme: Record<string, unknown> }>
      }
    ).certificatesResolvers
    expect(resolvers["kiln-ip"]?.acme).toMatchObject({ profile: "shortlived" })
  })

  it("leaves a pinned Traefik too old for the IP resolver serving as before", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "203.0.113.20",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })
    // A digest could be any version, so it counts as old too.
    for (const traefikImage of [
      "traefik:v3.3.0",
      `traefik@sha256:${"a".repeat(64)}`,
    ]) {
      const pinned = { ...settings, traefikImage }
      const resolvers = (
        parse(traefikStaticConfiguration(pinned, config)) as {
          certificatesResolvers: Record<string, unknown>
        }
      ).certificatesResolvers
      const dynamic = parse(
        traefikDynamicConfiguration(config, [route], pinned)
      ) as DynamicConfiguration & {
        http: { routers: Record<string, { tls?: Record<string, unknown> }> }
        tls?: unknown
      }

      expect(Object.keys(resolvers)).toEqual(["kiln"])
      expect(dynamic.http.routers["kiln-relay"]?.tls).toEqual({
        certResolver: "kiln",
      })
      expect(dynamic.tls).toBeUndefined()
      expect(dynamic.http.routers["kiln-route-b00d4423"]).toBeDefined()
    }
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

// Where a redirectRegex middleware sends a request, as Traefik's Go regexp
// expands its replacement.
function redirectTarget(middleware: Record<string, unknown>, url: string) {
  const { regex, replacement } = middleware.redirectRegex as {
    regex: string
    replacement: string
  }
  const match = new RegExp(regex, "u").exec(url)
  if (!match) return null
  return replacement.replace(/\$\$|\$\{(\d+)\}/gu, (token, group) =>
    token === "$$" ? "$" : (match[Number(group)] ?? "")
  )
}

describe("web route options", () => {
  const configuration = (routes: Array<typeof route>) =>
    parse(
      traefikDynamicConfiguration(
        loadConfig({
          KILN_RELAY_HOST: "relay.example.com",
          KILN_RELAY_PROXY: "traefik",
          NODE_ENV: "development",
        }),
        routes,
        settings
      )
    ) as DynamicConfiguration & {
      http: {
        routers: Record<
          string,
          { entryPoints: Array<string>; priority: number }
        >
      }
    }

  it("sends a hostname's www counterpart to it in one hop", () => {
    const { http } = configuration([{ ...route, path: null, www: "redirect" }])
    const name = "kiln-route-b00d4423"

    expect(http.routers[name]?.rule).toBe("Host(`donutsmp.example.com`)")
    for (const router of [`${name}-www`, `${name}-www-http`]) {
      expect(http.routers[router]?.rule).toBe(
        "Host(`www.donutsmp.example.com`)"
      )
      const [middleware] = http.routers[router]?.middlewares ?? []
      expect(
        redirectTarget(
          http.middlewares[middleware ?? ""] ?? {},
          "http://www.donutsmp.example.com/shop?id=4"
        )
      ).toBe("https://donutsmp.example.com/shop?id=4")
    }
  })

  it("serves both hostnames, and plain HTTP when a route asks", () => {
    const { http } = configuration([
      { ...route, httpsRedirect: false, path: null, www: "serve" },
    ])
    const name = "kiln-route-b00d4423"
    const rule =
      "Host(`donutsmp.example.com`) || Host(`www.donutsmp.example.com`)"

    expect(http.routers[name]).toMatchObject({ rule, service: name })
    expect(http.routers[`${name}-http`]).toMatchObject({
      entryPoints: ["web"],
      rule,
      service: name,
    })
  })

  it("redirects HTTP for a path route even when its hostname serves HTTP", () => {
    const { http } = configuration([
      { ...route, httpsRedirect: false, path: null },
      { ...route, id: "decafbad", path: "/admin" },
    ])
    const root = http.routers["kiln-route-b00d4423-http"]
    const admin = http.routers["kiln-route-decafbad-http"]

    expect(root?.middlewares).toBeUndefined()
    expect(admin?.rule).toBe(
      "Host(`donutsmp.example.com`) && PathPrefix(`/admin`)"
    )
    expect(admin?.priority).toBeGreaterThan(root?.priority ?? Infinity)
    expect(http.middlewares[admin?.middlewares?.[0] ?? ""]).toMatchObject({
      redirectScheme: { scheme: "https" },
    })
  })

  it("redirects a domain elsewhere, keeping or dropping the path", () => {
    const { http } = configuration([
      {
        ...route,
        path: null,
        redirect: {
          permanent: false,
          preservePath: true,
          to: "https://new.example.com/legacy",
        },
        targetPort: null,
      },
      {
        ...route,
        hostname: "old.example.com",
        id: "decafbad",
        path: null,
        redirect: {
          permanent: true,
          preservePath: false,
          to: "https://new.example.com/",
        },
        targetPort: null,
      },
    ])
    const kept = http.middlewares["kiln-route-b00d4423-to"] ?? {}
    const dropped = http.middlewares["kiln-route-decafbad-to"] ?? {}

    expect(http.routers["kiln-route-b00d4423"]?.service).toBe("noop@internal")
    expect(http.routers["kiln-route-b00d4423-http"]?.middlewares).toEqual([
      "kiln-route-b00d4423-to",
    ])
    expect(http.services["kiln-route-b00d4423"]).toBeUndefined()
    expect(kept).toMatchObject({ redirectRegex: { permanent: false } })
    expect(redirectTarget(kept, "https://donutsmp.example.com/a/b?c=1")).toBe(
      "https://new.example.com/legacy/a/b?c=1"
    )
    expect(redirectTarget(dropped, "http://old.example.com/a/b")).toBe(
      "https://new.example.com/"
    )
  })

  it("lets a route's own HTTP router win over the entry point redirect", () => {
    const configuration = parse(
      traefikStaticConfiguration(settings, {
        advertisedHost: "relay.example.com",
        platformEdge: null,
        proxyMode: "traefik",
        traefikAcmeCaServer: null,
      })
    ) as {
      entryPoints: {
        web: { http: { redirections: { entryPoint: { priority: number } } } }
      }
    }

    expect(
      configuration.entryPoints.web.http.redirections.entryPoint.priority
    ).toBe(1)
  })

  it("labels an external Traefik's redirect with a built-in service", () => {
    const labels = traefikRouteLabels(
      [
        {
          ...route,
          redirect: {
            permanent: true,
            preservePath: true,
            to: "https://new.example.com",
          },
          targetPort: null,
          www: "redirect",
        },
      ],
      coolify
    )
    const name = "kiln-route-b00d4423"

    expect(labels[`traefik.http.routers.${name}-https.rule`]).toBe(
      "(Host(`donutsmp.example.com`) || Host(`www.donutsmp.example.com`)) && PathPrefix(`/map`)"
    )
    expect(labels[`traefik.http.routers.${name}-https.service`]).toBe(
      "noop@internal"
    )
    // A placeholder, so a container without an exposed port keeps its labels.
    expect(
      labels[`traefik.http.services.${name}.loadbalancer.server.port`]
    ).toBe("80")
  })
})

describe("Hearth behind bundled Traefik in platform mode", () => {
  function platformConfiguration(host: string) {
    const config = loadConfig({
      KILN_PLATFORM_PROXY: "traefik",
      KILN_RELAY_MODE: "platform",
      NODE_ENV: "development",
    })
    config.platformEdge = {
      host,
      network: "kiln-platform",
      upstream: "http://kiln-hearth:3000",
    }
    return parse(
      traefikDynamicConfiguration(config, [route], {
        ...settings,
        mode: "hearth",
      })
    ) as DynamicConfiguration & {
      http: {
        routers: Record<string, { tls?: Record<string, unknown> }>
      }
      tls?: { stores: { default: { defaultGeneratedCert: unknown } } }
    }
  }

  it("serves an IP address's certificate to browsers that send no name", () => {
    const configuration = platformConfiguration("203.0.113.10")

    expect(configuration.http.routers["kiln-hearth"]?.tls).toEqual({
      certResolver: "kiln-ip",
      domains: [{ main: "203.0.113.10" }],
    })
    expect(configuration.tls?.stores.default.defaultGeneratedCert).toEqual({
      domain: { main: "203.0.113.10" },
      resolver: "kiln-ip",
    })
    expect(
      configuration.http.services["kiln-hearth"]?.loadBalancer.servers
    ).toEqual([{ url: "http://kiln-hearth:3000" }])
  })

  it("routes only Hearth, not the Relay's private name or Ember routes", () => {
    const configuration = platformConfiguration("kiln.example.com")

    expect(Object.keys(configuration.http.routers)).toEqual(["kiln-hearth"])
    expect(configuration.http.routers["kiln-hearth"]?.tls).toEqual({
      certResolver: "kiln",
    })
    expect(configuration.tls).toBeUndefined()
  })
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
      routeLabelsRequireRestart(
        { "traefik.enable": "false" },
        [],
        withoutRoutes
      )
    ).toBe(false)
    expect(
      routeLabelsRequireRestart(
        traefikRouteLabels([route], coolify),
        [],
        withoutRoutes
      )
    ).toBe(true)
    const routed = traefikRouteLabels([route], coolify)
    expect(routeLabelsRequireRestart(routed, [route], routed)).toBe(false)
  })
})

describe("external Traefik discovery", () => {
  let docker: DockerEngine
  beforeAll(async () => {
    docker = new DockerEngine(await fakeDocker.listen())
  })
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
          docker,
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
        docker,
        edgeNetwork: "kiln-edge",
        resourceNamespace: null,
        settings: { ...settings, mode: "none" },
      })
    ).resolves.toBe("host-traefik")
  })
})
