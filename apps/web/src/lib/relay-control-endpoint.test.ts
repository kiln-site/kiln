import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import {
  relayControlEndpoint,
  relayPairingOrigin,
} from "@/lib/relay-control-endpoint"

const relay = {
  hostname: "relay.feature.orb.local",
  id: "relay-id",
  managedTls: true,
  port: 443,
  useTls: true,
}

beforeEach(() => {
  vi.stubEnv("KILN_RELAY_CONTROL_URL", undefined)
  vi.stubEnv("KILN_RELAY_HOST", "relay.feature.orb.local")
  vi.stubEnv("KILN_RELAY_PORT", "4100")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Relay control endpoint", () => {
  it("uses the direct TLS listener for the environment-managed Relay CA", () => {
    expect(relayControlEndpoint(relay)).toEqual({
      ...relay,
      port: 4100,
      useTls: true,
    })
  })

  it("keeps edge-terminated Relay control on its advertised endpoint", () => {
    const edge = { ...relay, managedTls: false }

    expect(relayControlEndpoint(edge)).toEqual(edge)
  })

  it("preserves an explicit control endpoint override", () => {
    vi.stubEnv("KILN_RELAY_CONTROL_URL", "ws://relay:4100")

    expect(relayControlEndpoint(relay)).toEqual({
      ...relay,
      hostname: "relay",
      port: 4100,
      useTls: false,
    })
  })

  it("does not redirect an unrelated Relay", () => {
    vi.stubEnv("KILN_RELAY_CONTROL_URL", "ws://relay:4100")
    const remote = { ...relay, hostname: "relay.remote.example" }

    expect(relayControlEndpoint(remote)).toEqual(remote)
  })
})

describe("Relay pairing origin", () => {
  it("uses the direct listener for the environment-managed Relay CA", () => {
    const origin = relayPairingOrigin({
      browserOrigin: new URL("https://relay.feature.orb.local"),
      caCertificatePem: "managed Relay CA",
    })

    expect(origin.href).toBe("https://relay.feature.orb.local:4100/")
  })

  it("keeps edge-terminated pairing on the advertised browser origin", () => {
    const browserOrigin = new URL("https://relay.feature.orb.local")

    expect(relayPairingOrigin({ browserOrigin, caCertificatePem: null })).toBe(
      browserOrigin
    )
  })

  it("does not redirect an unrelated managed Relay to the local listener", () => {
    const browserOrigin = new URL("https://relay.remote.example")

    expect(
      relayPairingOrigin({ browserOrigin, caCertificatePem: "remote Relay CA" })
    ).toBe(browserOrigin)
  })

  it("prefers a verified bootstrap enrollment origin", () => {
    const enrollmentOrigin = new URL("https://relay.feature.orb.local:4100")

    expect(
      relayPairingOrigin({
        browserOrigin: new URL("https://relay.feature.orb.local"),
        caCertificatePem: "managed Relay CA",
        enrollmentOrigin,
      })
    ).toBe(enrollmentOrigin)
  })
})
