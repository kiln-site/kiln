import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  findTailscaleDevice,
  removeTailscaleControlPlaneDeviceEffect,
  requiredTailscaleOAuthScopes,
  syncTailscaleControlPlaneEffect,
  verifyTailscaleOAuthCredentialEffect,
} from "./tailscale-api"

describe("Tailscale API integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("matches a node by its stable Tailscale address before hostname", () => {
    const selected = findTailscaleDevice(
      [
        {
          addresses: ["100.64.12.96"],
          hostname: "renamed-node",
          id: "device-address",
        },
        {
          addresses: ["100.64.99.99"],
          hostname: "kiln-network-node",
          id: "device-hostname",
        },
      ],
      {
        hostname: "kiln-network-node",
        status: { ipv4Address: "100.64.12.96" },
        subnet: "10.187.39.0/24",
      }
    )

    expect(selected?.id).toBe("device-address")
  })

  it("falls back to the node's MagicDNS name", () => {
    const selected = findTailscaleDevice(
      [
        {
          addresses: ["100.64.99.99"],
          id: "device-hostname",
          name: "kiln-network-node.example.ts.net",
        },
      ],
      {
        hostname: "kiln-network-node",
        status: { ipv4Address: null },
        subnet: "10.187.39.0/24",
      }
    )

    expect(selected?.id).toBe("device-hostname")
  })

  it("verifies requested scopes and tags without treating the client as an auth key", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        access_token: "access-token",
        expires_in: 3_600,
        scope: requiredTailscaleOAuthScopes.join(" "),
        token_type: "Bearer",
      })
    )

    const verified = await Effect.runPromise(
      verifyTailscaleOAuthCredentialEffect(
        "oauth-client",
        "oauth-client-secret",
        ["tag:kiln"]
      )
    )

    expect(verified).toEqual({
      clientId: "oauth-client",
      scopes: [...requiredTailscaleOAuthScopes].sort(),
      tags: ["tag:kiln"],
    })
  })

  it("clears split DNS when a network no longer has deployments", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/oauth/token")) {
          return Response.json({
            access_token: "access-token",
            scope: requiredTailscaleOAuthScopes.join(" "),
          })
        }
        return Response.json({})
      }
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await Effect.runPromise(
      syncTailscaleControlPlaneEffect(
        {
          clientId: "oauth-client",
          clientSecret: "oauth-client-secret",
          scopes: [...requiredTailscaleOAuthScopes],
          tags: ["tag:kiln"],
        },
        {
          deployments: [],
          domain: "test",
          id: "a".repeat(40),
          name: "Test network",
        }
      )
    )

    expect(result).toEqual({ resolvers: [] })
    const [, init] =
      fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith("/dns/split-dns")
      ) ?? []
    expect(JSON.parse(String(init?.body))).toEqual({ test: null })
  })

  it("deletes a leaving node from the Tailnet", async () => {
    const deleted: Array<string> = []
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/oauth/token")) {
          return Response.json({
            access_token: "access-token",
            scope: requiredTailscaleOAuthScopes.join(" "),
          })
        }
        if (url.includes("/tailnet/-/devices")) {
          return Response.json({
            devices: [
              {
                addresses: ["100.64.12.96"],
                hostname: "kiln-network-node",
                id: "device-id",
              },
            ],
          })
        }
        if (init?.method === "DELETE") deleted.push(url)
        return new Response(null, { status: 204 })
      }
    )
    vi.stubGlobal("fetch", fetchMock)

    await Effect.runPromise(
      removeTailscaleControlPlaneDeviceEffect(
        {
          clientId: "oauth-client",
          clientSecret: "oauth-client-secret",
          scopes: [...requiredTailscaleOAuthScopes],
          tags: ["tag:kiln"],
        },
        {
          hostname: "kiln-network-node",
          status: { ipv4Address: "100.64.12.96" },
          subnet: "10.187.39.0/24",
        }
      )
    )

    expect(deleted).toEqual([
      "https://api.tailscale.com/api/v2/device/device-id",
    ])
  })

  it("rejects a subnet already advertised by another Tailnet device", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/oauth/token")) {
          return Response.json({
            access_token: "access-token",
            scope: requiredTailscaleOAuthScopes.join(" "),
          })
        }
        if (url.includes("/tailnet/-/devices")) {
          return Response.json({
            devices: [
              {
                addresses: ["100.64.12.96"],
                hostname: "kiln-network-node",
                id: "target-device",
              },
              {
                hostname: "existing-router",
                id: "existing-device",
              },
            ],
          })
        }
        if (url.endsWith("/device/target-device/routes")) {
          return Response.json({
            advertisedRoutes: ["10.187.39.0/24"],
            enabledRoutes: [],
          })
        }
        if (url.endsWith("/device/existing-device/routes")) {
          return Response.json({
            advertisedRoutes: ["10.187.39.0/24"],
            enabledRoutes: ["10.187.39.0/24"],
          })
        }
        return Response.json({})
      }
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      Effect.runPromise(
        syncTailscaleControlPlaneEffect(
          {
            clientId: "oauth-client",
            clientSecret: "oauth-client-secret",
            scopes: [...requiredTailscaleOAuthScopes],
            tags: ["tag:kiln"],
          },
          {
            deployments: [
              {
                hostname: "kiln-network-node",
                status: { ipv4Address: "100.64.12.96" },
                subnet: "10.187.39.0/24",
              },
            ],
            domain: "test",
            id: "a".repeat(40),
            name: "Test network",
          }
        )
      )
    ).rejects.toThrow("already advertised by existing-router")
  })
})
