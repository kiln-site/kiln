import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

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
