import { describe, expect, it, vi } from "vite-plus/test"
import type {
  RelayProxyDiagnostics,
  RelayProxySettings,
} from "@workspace/contracts"

import { readRelayProxy } from "./proxy-read.js"

const settings: RelayProxySettings = {
  acmeEmail: null,
  mode: "none",
  traefikImage: "traefik:v3.6",
}

const diagnostics: RelayProxyDiagnostics = {
  browserOrigin: "https://relay.example.com",
  containerRunning: false,
  mode: "none",
  ports: [],
  publicReachability: "unknown",
  status: "disabled",
  warnings: [],
}

describe("Relay proxy reads", () => {
  it("does not load diagnostics for browser metadata reads", async () => {
    const loadDiagnostics = vi.fn(async () => diagnostics)

    await expect(
      readRelayProxy({
        browserOrigin: "https://relay.example.com",
        includeDiagnostics: false,
        loadDiagnostics,
        settings,
      })
    ).resolves.toEqual({
      browserOrigin: "https://relay.example.com",
      mode: "none",
    })
    expect(loadDiagnostics).not.toHaveBeenCalled()
  })

  it("preserves the full diagnostics response by default", async () => {
    const loadDiagnostics = vi.fn(async () => diagnostics)

    await expect(
      readRelayProxy({
        browserOrigin: "https://relay.example.com",
        includeDiagnostics: true,
        loadDiagnostics,
        settings,
      })
    ).resolves.toEqual({ diagnostics, settings })
    expect(loadDiagnostics).toHaveBeenCalledOnce()
  })
})
