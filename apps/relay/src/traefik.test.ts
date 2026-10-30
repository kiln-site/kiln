import { relayInstanceWebRoutesSchema } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import type { RelayStoredWebRoute } from "./effect/state.js"
import { recoveryRouteLabels } from "./traefik.js"

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

describe("web route rules", () => {
  it("rejects paths that can escape a Traefik rule literal", () => {
    expect(() =>
      relayInstanceWebRoutesSchema.parse([
        { ...route, path: "/map`) || Host(`relay.example.com`)" },
      ])
    ).toThrow("routing metacharacters")
  })
})

describe("external Traefik labels", () => {
  it("stores recovery labels without exposing the Ember to Traefik", () => {
    const labels = recoveryRouteLabels([route])

    expect(labels["traefik.enable"]).toBe("false")
    expect(labels["traefik.docker.network"]).toBeUndefined()
    expect(labels["kiln.relay.web-routes.b00d4423"]).toBeDefined()
  })
})
