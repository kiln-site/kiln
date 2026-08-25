import { describe, expect, it } from "vite-plus/test"

import {
  createConsoleAggregateStreamStore,
  createConsoleUiStore,
} from "./console-stores"

describe("Tailscale console stores", () => {
  it("combines relay streams without colliding line identities", () => {
    const store = createConsoleAggregateStreamStore("network-id")
    const snapshot = {
      connection: "live" as const,
      consoleData: {
        instanceId: "network-id",
        lifecycle: [],
        lines: [
          {
            id: "same-line",
            timestamp: "2026-07-27T12:00:00.000Z",
            level: "info" as const,
            service: "tailscale" as const,
            text: "[tailscale] ready",
          },
        ],
        truncated: false,
      },
      error: null,
      loading: false,
      transport: "hearth" as const,
      transportMessage: null,
    }

    store.setSourceSnapshot(
      "relay-one",
      { id: "relay-one", name: "Kiln One" },
      snapshot
    )
    store.setSourceSnapshot(
      "relay-two",
      { id: "relay-two", name: "Kiln Two" },
      snapshot
    )

    expect(store.getSnapshot().consoleData?.lines).toMatchObject([
      { id: "relay-one:same-line", relayId: "relay-one" },
      { id: "relay-two:same-line", relayId: "relay-two" },
    ])

    store.removeSource("relay-one")
    expect(store.getSnapshot().consoleData?.lines).toMatchObject([
      { id: "relay-two:same-line", relayId: "relay-two" },
    ])
  })

  it("defaults relay and service filters to all", () => {
    const store = createConsoleUiStore()

    expect(store.getRelayIdsSnapshot()).toBeNull()
    expect(store.getServicesSnapshot()).toBeNull()

    store.toggleRelay("relay-one", ["relay-one", "relay-two"])
    expect([...store.getRelayIdsSnapshot()!]).toEqual(["relay-one"])
    store.toggleRelay("relay-two", ["relay-one", "relay-two"])
    expect(store.getRelayIdsSnapshot()).toBeNull()

    store.toggleService("coredns")
    expect([...store.getServicesSnapshot()!]).toEqual(["coredns"])
    store.toggleService("tailscale")
    expect(store.getServicesSnapshot()).toBeNull()
  })
})
