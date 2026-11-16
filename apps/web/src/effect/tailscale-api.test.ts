import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createTailscaleNodeAuthKeyEffect,
  syncTailscaleControlPlaneEffect,
} from "./tailscale-api"

// Tailscale's API is the fake: it answers on the paths Tailscale documents
// (`/tailnet/-/…` for the tailnet the OAuth client belongs to) and nowhere
// else, keeping a gateway's device, its routes and the split DNS it was given.
function fakeTailscale() {
  const state = {
    keys: 0,
    routes: {
      advertisedRoutes: ["10.100.0.0/24"],
      enabledRoutes: [] as string[],
    },
    splitDns: {} as Record<string, ReadonlyArray<string> | null>,
  }
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const path = url.pathname.replace("/api/v2", "")
    const method = init?.method ?? "GET"
    if (path === "/oauth/token" && method === "POST") {
      return json({
        access_token: "token",
        scope: "auth_keys devices:core devices:routes dns",
      })
    }
    if (path === "/tailnet/-/keys" && method === "POST") {
      state.keys += 1
      return json({
        id: `k${state.keys}`,
        key: "tskey-auth-kTest-0123456789abcdef",
      })
    }
    if (path === "/tailnet/-/devices" && method === "GET") {
      return json({
        devices: [
          {
            hostname: "home-relay",
            id: "device-1",
            name: "home-relay.example.ts.net",
          },
        ],
      })
    }
    if (path === "/device/device-1/routes") {
      if (method === "POST") {
        state.routes.enabledRoutes = (
          JSON.parse(String(init?.body)) as { routes: string[] }
        ).routes
      }
      return json(state.routes)
    }
    if (path === "/tailnet/-/dns/split-dns" && method === "PATCH") {
      Object.assign(state.splitDns, JSON.parse(String(init?.body)))
      return json(
        Object.fromEntries(
          Object.entries(state.splitDns).filter(([, value]) => value !== null)
        )
      )
    }
    return new Response("not found", { status: 404 })
  })
  return state
}

const credential = {
  clientId: "client",
  clientSecret: "tskey-client-secret-0123456789",
  scopes: [],
  tags: ["tag:kiln"],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Tailscale's API", () => {
  // A regression: renaming tailnets to tunnels once rewrote Tailscale's own
  // `/tailnet/-/` paths, and every save failed with HTTP 404.
  it("approves a gateway's routes and points the tunnel's TLDs at it", async () => {
    const tailscale = fakeTailscale()

    await Effect.runPromise(
      syncTailscaleControlPlaneEffect(credential, {
        domains: ["kiln"],
        gateways: [
          {
            hostname: "home-relay",
            status: { ipv4Address: "100.64.0.9" },
            subnet: "10.100.0.0/24",
          },
        ],
        id: "a".repeat(12),
        name: "Home",
      })
    )

    expect(tailscale.routes.enabledRoutes).toEqual(["10.100.0.0/24"])
    expect(tailscale.splitDns).toEqual({ kiln: ["100.64.0.9"] })
  })

  it("makes a key a new gateway logs in with", async () => {
    const tailscale = fakeTailscale()

    const key = await Effect.runPromise(
      createTailscaleNodeAuthKeyEffect(credential, "home-relay")
    )

    expect(key).toContain("tskey-auth-")
    expect(tailscale.keys).toBe(1)
  })
})
