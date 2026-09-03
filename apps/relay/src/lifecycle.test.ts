import { describe, expect, it } from "vite-plus/test"
import {
  relayInstanceTailscaleSchema,
  relayInstanceWebRoutesSchema,
  relayTailscaleDomainSchema,
  relayTailscaleStackApplySchema,
  relayTailscaleStackConfigSchema,
  relayTailscaleStackSchema,
} from "@workspace/contracts"

import { loadConfig } from "./config.js"
import {
  coreDnsHostnamePattern,
  discoverExternalTraefikContainer,
  LifecycleDriver,
  nextManagedGamePort,
  recoveryRouteLabels,
  routeLabelsRequireRestart,
  allocateTailscaleBindingAddress,
  allocateTailscaleStackSubnet,
  assignTailscaleBindingAddresses,
  tailscaleStackCoreDnsConfiguration,
  tailscaleStackCoreDnsRecords,
  tailscaleStackFirewallIsCurrent,
  tailscaleStackFirewallRules,
  tailscaleStackPendingRemoval,
  tailscaleStackServiceAddress,
  tailscaleStackSubnet,
  tailscaleStackWithoutInstance,
  tailscaleCoreDnsConfiguration,
  traefikDynamicConfiguration,
  traefikRouteLabels,
  traefikStaticConfiguration,
} from "./lifecycle.js"

describe("managed game ports", () => {
  it("assigns a stable available port and probes past collisions", () => {
    const range = {
      end: 30_002,
      instanceId: "a".repeat(40),
      start: 30_000,
    }
    const preferred = nextManagedGamePort({
      ...range,
      unavailable: new Set(),
    })
    const next = nextManagedGamePort({
      ...range,
      unavailable: new Set([preferred]),
    })

    expect(preferred).toBeGreaterThanOrEqual(range.start)
    expect(preferred).toBeLessThanOrEqual(range.end)
    expect(next).not.toBe(preferred)
    expect(() =>
      nextManagedGamePort({
        ...range,
        unavailable: new Set([30_000, 30_001, 30_002]),
      })
    ).toThrow("No game ports are available")
  })
})

describe("external Traefik discovery", () => {
  it.each(["none", "hearth", "traefik"] as const)(
    "only inspects proxies attached to a namespaced edge in %s mode",
    async (mode) => {
      const calls: Array<Array<string>> = []
      const discovered = await discoverExternalTraefikContainer(
        {
          edgeNetwork: "hearth-feature-a1b2c3-kiln-edge",
          resourceNamespace: "hearth-feature-a1b2c3",
          settings: {
            acmeEmail: null,
            mode,
            traefikImage: "traefik:v3.6.6",
          },
        },
        async (_executable, arguments_) => {
          calls.push(arguments_)
          if (arguments_[0] === "network") {
            return {
              stderr: "",
              stdout: "hearth-feature-a1b2c3-kiln-aaaaaaaa\nmanual-traefik\n",
            }
          }
          const name = arguments_.at(-1)
          return {
            stderr: "",
            stdout:
              name === "manual-traefik"
                ? "true traefik:v3.6.6\n"
                : "true ghcr.io/kiln-site/ember:latest\n",
          }
        }
      )

      expect(discovered).toBe("manual-traefik")
      expect(calls.some((arguments_) => arguments_[0] === "ps")).toBe(false)
    }
  )

  it("preserves host proxy discovery for unscoped Relays", async () => {
    const calls: Array<Array<string>> = []
    const discovered = await discoverExternalTraefikContainer(
      {
        edgeNetwork: "kiln-edge",
        resourceNamespace: null,
        settings: {
          acmeEmail: null,
          mode: "none",
          traefikImage: "traefik:v3.6.6",
        },
      },
      async (_executable, arguments_) => {
        calls.push(arguments_)
        if (arguments_[0] === "ps") {
          return {
            stderr: "",
            stdout: arguments_.includes("publish=443") ? "host-traefik\n" : "",
          }
        }
        return {
          stderr: "",
          stdout:
            arguments_.at(-1) === "host-traefik" ? "true traefik:v3.6.6\n" : "",
        }
      }
    )

    expect(discovered).toBe("host-traefik")
    expect(calls.some((arguments_) => arguments_[0] === "network")).toBe(false)
  })
})

describe("CoreDNS Brick hostnames", () => {
  it("matches only deployed hostnames and implementation aliases", () => {
    const expression = coreDnsHostnamePattern("kiln.test", [
      "1.21.11.paper.kiln.test",
      "paper.kiln.test",
      "palworld.kiln.test:8211",
      "outside.example",
    ])
    const pattern = new RegExp(expression.replace(/^\(\?i\)/u, ""), "iu")

    expect(pattern.test("1.21.11.paper.kiln.test.")).toBe(true)
    expect(pattern.test("PAPER.KILN.TEST.")).toBe(true)
    expect(pattern.test("palworld.kiln.test.")).toBe(false)
    expect(pattern.test("kiln.test.")).toBe(false)
    expect(pattern.test("typo.kiln.test.")).toBe(false)
    expect(pattern.test("outside.example.")).toBe(false)
  })

  it("matches nothing before the first Brick is deployed", () => {
    const pattern = new RegExp(coreDnsHostnamePattern("kiln.test", []), "u")
    expect(pattern.test("kiln.test.")).toBe(false)
    expect(pattern.test("anything.kiln.test.")).toBe(false)
  })

  it("binds the private zone only to the node Tailscale address", () => {
    const configuration = tailscaleCoreDnsConfiguration(
      {
        dnsPort: 53,
        domain: "test",
        hostname: "kiln-node",
      },
      "100.91.22.14",
      ["1.21.11.paper.test"]
    )

    expect(configuration).toContain("test:53 {")
    expect(configuration).toContain("bind 100.91.22.14")
    expect(configuration).toContain('answer "{{ .Name }} 60 IN A 100.91.22.14"')
    expect(configuration).toContain("1\\.21\\.11\\.paper\\.test")
  })
})

describe("Tailscale contracts", () => {
  it("normalizes dot-prefixed domains and server subdomains", () => {
    expect(relayTailscaleDomainSchema.parse(" .TEST. ")).toBe("test")
    expect(
      relayInstanceTailscaleSchema.parse({
        enabled: true,
        subdomain: " 1.21.11.Paper. ",
      })
    ).toEqual({ enabled: true, subdomain: "1.21.11.paper" })
  })

  it("requires a subdomain when a server joins Tailscale", () => {
    expect(
      relayInstanceTailscaleSchema.safeParse({ enabled: true }).success
    ).toBe(false)
    expect(relayInstanceTailscaleSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    })
  })

  it("normalizes a logical stack before it is placed on a node", () => {
    const stack = relayTailscaleStackApplySchema.parse({
      authKey: "tskey-auth-example",
      bindings: [
        {
          hostname: " Paper ",
          instanceId: "b".repeat(40),
        },
      ],
      domain: " .TEST. ",
      hostname: " Private-Network ",
      id: "a".repeat(40),
      name: "Private Network",
    })

    expect(stack.domain).toBe("test")
    expect(stack.hostname).toBe("private-network")
    expect(stack.bindings[0]?.hostname).toBe("paper")
  })
})

describe("Tailscale Brick networking", () => {
  it("allows selected servers before dropping other traffic without bypassing Tailscale forwarding", () => {
    expect(
      tailscaleStackFirewallRules([
        { address: "10.165.55.10" },
        { address: "10.165.55.11" },
      ])
    ).toEqual([
      ["-A", "KILN-TAILSCALE", "-d", "10.165.55.10/32", "-j", "RETURN"],
      ["-A", "KILN-TAILSCALE", "-d", "10.165.55.11/32", "-j", "RETURN"],
      ["-A", "KILN-TAILSCALE", "-j", "DROP"],
    ])
  })

  it("recognizes only a complete installed forwarding allowlist", () => {
    const bindings = [{ address: "10.165.55.10" }]
    const specification = [
      "-N KILN-TAILSCALE",
      "-A KILN-TAILSCALE -d 10.165.55.10/32 -j RETURN",
      "-A KILN-TAILSCALE -j DROP",
    ].join("\n")

    expect(tailscaleStackFirewallIsCurrent(true, specification, bindings)).toBe(
      true
    )
    expect(
      tailscaleStackFirewallIsCurrent(false, specification, bindings)
    ).toBe(false)
    expect(
      tailscaleStackFirewallIsCurrent(
        true,
        "-A KILN-TAILSCALE -j DROP",
        bindings
      )
    ).toBe(false)
  })

  it("assigns stable node-specific subnets and reserves service addresses", () => {
    const stackId = "a".repeat(40)
    const first = tailscaleStackSubnet(stackId, "node-a")
    const second = tailscaleStackSubnet(stackId, "node-b")

    expect(first).toMatch(/^10\.(?:12[89]|1[3-8]\d|19[01])\.\d{1,3}\.0\/24$/u)
    expect(second).not.toBe(first)
    expect(tailscaleStackServiceAddress(first)).toMatch(/\.2$/u)
  })

  it("probes to another deterministic subnet when the preferred one is reserved", () => {
    const stackId = "a".repeat(40)
    const preferred = allocateTailscaleStackSubnet(stackId, "node-a", new Set())
    const replacement = allocateTailscaleStackSubnet(
      stackId,
      "node-a",
      new Set([preferred])
    )

    expect(replacement).not.toBe(preferred)
    expect(
      allocateTailscaleStackSubnet(stackId, "node-a", new Set([preferred]))
    ).toBe(replacement)
  })

  it("keeps existing server addresses reserved while allocating new ones", () => {
    const reserved = new Set(["10.165.55.10", "10.165.55.11"])

    expect(allocateTailscaleBindingAddress("10.165.55.0/24", reserved)).toBe(
      "10.165.55.12"
    )
  })

  it("reclaims removed addresses while replacing a full subnet in one apply", () => {
    const existing = Array.from({ length: 245 }, (_, index) => ({
      address: `10.165.55.${index + 10}`,
      hostname: `old-${index}`,
      instanceId: `old-${index}`,
    }))
    const desired = Array.from({ length: 245 }, (_, index) => ({
      hostname: `new-${index}`,
      instanceId: `new-${index}`,
    }))

    const assigned = assignTailscaleBindingAddresses(
      "10.165.55.0/24",
      existing,
      desired
    )

    expect(assigned).toHaveLength(245)
    expect(assigned[0]?.address).toBe("10.165.55.10")
    expect(assigned.at(-1)?.address).toBe("10.165.55.254")
  })

  it("keeps retained addresses reserved while reusing removed addresses", () => {
    const assigned = assignTailscaleBindingAddresses(
      "10.165.55.0/24",
      [
        {
          address: "10.165.55.10",
          hostname: "removed",
          instanceId: "removed",
        },
        {
          address: "10.165.55.11",
          hostname: "retained",
          instanceId: "retained",
        },
      ],
      [
        { hostname: "replacement", instanceId: "replacement" },
        {
          enabled: false,
          hostname: "retained-new-name",
          instanceId: "retained",
        },
      ]
    )

    expect(assigned).toEqual([
      {
        address: "10.165.55.10",
        enabled: true,
        hostname: "replacement",
        instanceId: "replacement",
      },
      {
        address: "10.165.55.11",
        enabled: false,
        hostname: "retained-new-name",
        instanceId: "retained",
      },
    ])
  })

  it("renders deterministic cross-node DNS records", () => {
    const configuration = tailscaleStackCoreDnsConfiguration("test", [
      { address: "10.140.2.10", hostname: "survival" },
      { address: "10.165.55.10", hostname: "paper" },
    ])

    expect(configuration).toContain("test:53 {")
    expect(configuration).toContain("10.165.55.10 paper.test")
    expect(configuration).toContain("10.140.2.10 survival.test")
    expect(configuration.indexOf("paper.test")).toBeLessThan(
      configuration.indexOf("survival.test")
    )
    expect(tailscaleStackCoreDnsRecords("test", configuration)).toEqual([
      { address: "10.165.55.10", hostname: "paper" },
      { address: "10.140.2.10", hostname: "survival" },
    ])
  })

  it("removes a deleted server binding and only its replicated DNS record", () => {
    const removedId = "b".repeat(40)
    const retainedId = "c".repeat(40)
    const config = relayTailscaleStackConfigSchema.parse({
      bindings: [
        {
          address: "10.165.55.10",
          hostname: "paper",
          instanceId: removedId,
        },
        {
          address: "10.165.55.11",
          hostname: "survival",
          instanceId: retainedId,
        },
      ],
      domain: "test",
      hostname: "private-network",
      id: "a".repeat(40),
      name: "Private Network",
      subnet: "10.165.55.0/24",
    })

    expect(
      tailscaleStackWithoutInstance(
        config,
        [
          { address: "10.165.55.10", hostname: "paper" },
          { address: "10.165.55.11", hostname: "survival" },
          { address: "10.140.2.10", hostname: "remote" },
        ],
        removedId
      )
    ).toMatchObject({
      config: {
        bindings: [
          {
            address: "10.165.55.11",
            hostname: "survival",
            instanceId: retainedId,
          },
        ],
      },
      records: [
        { address: "10.165.55.11", hostname: "survival" },
        { address: "10.140.2.10", hostname: "remote" },
      ],
    })
  })

  it("keeps a prepared removal discoverable after its containers are gone", () => {
    const id = "a".repeat(40)
    const config = relayTailscaleStackConfigSchema.parse({
      bindings: [
        {
          address: "10.165.55.10",
          hostname: "paper",
          instanceId: "b".repeat(40),
        },
      ],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
      subnet: "10.165.55.0/24",
    })
    const snapshot = relayTailscaleStackSchema.parse({
      ...config,
      components: {
        coreDnsRunning: true,
        tailscaleRunning: true,
      },
      instance: {
        brickId: "tailscale",
        connectAddress: "private-network.test",
        containerId: "docker-container-id",
        desiredState: "running",
        directory: id,
        game: "Networking",
        id,
        implementation: "Tailscale",
        javaVersion: "Tailscale + CoreDNS",
        managedByRelay: true,
        name: "Private Network",
        observedState: "running",
        service: "kiln-tailscale-private-network",
        shortId: id.slice(0, 8),
        lifecycle: [
          { state: "started", time: "2026-07-28T12:00:00.000Z" },
          { state: "ready", time: "2026-07-28T12:00:15.000Z" },
        ],
        status: "Running",
        version: "stable",
      },
      status: {
        connected: true,
        ipv4Address: "100.64.12.96",
        ipv6Address: null,
        message: null,
      },
    })

    const pending = tailscaleStackPendingRemoval(config, snapshot)

    expect(pending.components).toEqual({
      coreDnsRunning: false,
      tailscaleRunning: false,
    })
    expect(pending.status).toEqual({
      connected: false,
      ipv4Address: null,
      ipv6Address: null,
      message: "Removal pending",
    })
    expect(pending.instance).toMatchObject({
      containerId: null,
      observedState: "stopped",
      status: "Removal pending",
    })
    expect(pending.bindings).toEqual(config.bindings)
  })
})

describe("Traefik web routes", () => {
  const settings = {
    acmeEmail: "admin@example.com",
    mode: "traefik" as const,
    traefikImage: "traefik:v3.6.6",
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

  it("configures ACME and applies routes without a Docker provider", () => {
    const staticConfiguration = traefikStaticConfiguration(settings)
    const dynamicConfiguration = traefikDynamicConfiguration(
      loadConfig({
        KILN_HEARTH_INTERNAL_URL: "http://hearth:3000",
        KILN_HEARTH_PUBLIC_URL: "https://hearth.example.com",
        KILN_RELAY_HOST: "relay.example.com",
        KILN_RELAY_PROXY: "traefik",
        NODE_ENV: "development",
      }),
      [route],
      settings
    )

    expect(staticConfiguration).toContain("httpChallenge:")
    expect(staticConfiguration).toContain("admin@example.com")
    expect(staticConfiguration).not.toContain("docker.sock")
    expect(dynamicConfiguration).toContain("PathPrefix(`/map`)")
    expect(dynamicConfiguration).toContain("Host(`hearth.example.com`)")
    expect(dynamicConfiguration).toContain("http://hearth:3000")
    expect(dynamicConfiguration).toContain("http://kiln-relay:4100")
    expect(dynamicConfiguration).toContain("http://kiln-aaaaaaaa:8080")
    expect(dynamicConfiguration).not.toContain("rootCAs:")
    expect(dynamicConfiguration).toContain("stripPrefix:")
  })

  it("uses namespaced Ember targets for an isolated Relay", () => {
    const dynamicConfiguration = traefikDynamicConfiguration(
      loadConfig({
        KILN_RELAY_HOST: "relay.example.com",
        KILN_RELAY_PROXY: "traefik",
        KILN_RELAY_RESOURCE_NAMESPACE: "hearth-feature-a1b2c3",
        NODE_ENV: "development",
      }),
      [route],
      settings
    )

    expect(dynamicConfiguration).toContain(
      "http://hearth-feature-a1b2c3-kiln-aaaaaaaa:8080"
    )
  })

  it("only publishes the configured Hearth origin in bundled mode", () => {
    const config = loadConfig({
      KILN_HEARTH_INTERNAL_URL: "http://hearth:3000",
      KILN_HEARTH_PUBLIC_URL: "https://hearth.example.com",
      KILN_RELAY_HOST: "relay.example.com",
      NODE_ENV: "development",
    })

    expect(
      traefikDynamicConfiguration(config, [], {
        ...settings,
        mode: "none",
      })
    ).not.toContain("kiln-hearth")
  })

  it("builds direct Ember labels for a Coolify Traefik edge", () => {
    const labels = traefikRouteLabels([route], {
      certificateResolver: "letsencrypt",
      httpEntryPoint: "http",
      httpsEntryPoint: "https",
    })
    const name = "kiln-route-b00d4423"
    expect(labels["traefik.enable"]).toBe("true")
    expect(labels["traefik.docker.network"]).toBe("kiln-edge")
    expect(labels[`traefik.http.routers.${name}-https.entrypoints`]).toBe(
      "https"
    )
    expect(labels[`traefik.http.routers.${name}-https.tls.certresolver`]).toBe(
      "letsencrypt"
    )
    expect(
      labels[`traefik.http.services.${name}.loadbalancer.server.port`]
    ).toBe("8080")
    expect(labels["kiln.relay.web-routes.b00d4423"]).toBe(
      "donutsmp.example.com:8080/map|name=Live%20Map"
    )
    expect(labels["kiln.relay.web-routes.revision"]).toMatch(/^[a-f0-9]{64}$/u)
  })

  it("stores recovery labels without exposing the Ember to Traefik", () => {
    const labels = recoveryRouteLabels([route])

    expect(labels["traefik.enable"]).toBe("false")
    expect(labels["traefik.docker.network"]).toBeUndefined()
    expect(labels["kiln.relay.web-routes.b00d4423"]).toBe(
      "donutsmp.example.com:8080/map|name=Live%20Map"
    )
    expect(labels["kiln.relay.web-routes.revision"]).toMatch(/^[a-f0-9]{64}$/u)
  })

  it("hydrates the trusted Coolify edge without advertising private port 4100", () => {
    const config = loadConfig({
      KILN_RELAY_PROXY: "coolify",
      SERVICE_URL_KILN_RELAY_4100: "https://relay.example.com",
      NODE_ENV: "production",
    })
    const lifecycle = new LifecycleDriver(config, null as never, null as never)

    lifecycle.hydrateProxySettings({ ...settings, mode: "coolify" })

    expect(config.publicPort).toBe(443)
    expect(config.browserOrigin).toBe("https://relay.example.com")
  })

  it("does not recreate an untouched Ember with no routes", () => {
    const profile = {
      certificateResolver: "letsencrypt",
      httpEntryPoint: "http",
      httpsEntryPoint: "https",
    }
    const desired = traefikRouteLabels([], profile)
    expect(
      routeLabelsRequireRestart({ "traefik.enable": "false" }, [], desired)
    ).toBe(false)
    expect(
      routeLabelsRequireRestart(
        traefikRouteLabels([route], profile),
        [],
        desired
      )
    ).toBe(true)
  })

  it("rejects paths that can escape a Traefik rule literal", () => {
    expect(() =>
      relayInstanceWebRoutesSchema.parse([
        {
          ...route,
          path: "/map`) || Host(`relay.example.com`)",
        },
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

  it("restores the direct endpoint when bundled Traefik is disabled", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })
    const lifecycle = new LifecycleDriver(config, null as never, null as never)

    lifecycle.hydrateProxySettings({ ...settings, mode: "none" })
    expect(config.publicPort).toBe(4100)
    expect(config.browserOrigin).toBe("http://relay.example.com:4100")

    lifecycle.hydrateProxySettings(settings)
    expect(config.publicPort).toBe(443)
    expect(config.browserOrigin).toBe("https://relay.example.com")
  })
})
