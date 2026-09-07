import { describe, expect, it, vi } from "vite-plus/test"

import {
  createConsoleAggregateStreamStore,
  createConsoleStreamStore,
  createConsoleUiStore,
} from "./console-stores"

it("retries only the connection subscribers without clearing output", () => {
  const store = createConsoleStreamStore()
  const view = vi.fn()
  const reconnect = vi.fn()
  store.subscribe(view)
  const unsubscribe = store.subscribeRetry(reconnect)
  const before = store.getSnapshot()
  store.retry()
  expect(store.getRetrySnapshot()).toBe(1)
  expect(reconnect).toHaveBeenCalledOnce()
  expect(view).not.toHaveBeenCalled()
  expect(store.getSnapshot()).toBe(before)
  unsubscribe()
  store.retry()
  expect(reconnect).toHaveBeenCalledOnce()
})

describe("Tailscale console stores", () => {
  it("keeps partial and reconnecting failures retryable until each source recovers", () => {
    const store = createConsoleAggregateStreamStore("network-id")
    const healthy = {
      ...createConsoleStreamStore().getSnapshot(),
      connection: "live" as const,
      loading: false,
    }
    const failed = {
      ...healthy,
      connection: "reconnecting" as const,
      error: "Connection failed",
    }
    const first = { id: "one", name: "Relay One" }
    const second = { id: "two", name: "Relay Two" }
    store.setSourceSnapshot(first.id, first, failed)
    expect(store.getSnapshot().error).toBe("Relay One: Connection failed")
    store.setSourceSnapshot(second.id, second, healthy)
    expect(store.getSnapshot()).toMatchObject({
      connection: "live",
      error: "Relay One: Connection failed",
    })
    store.setSourceSnapshot(first.id, first, healthy)
    expect(store.getSnapshot().error).toBeNull()
    store.setSourceSnapshot(second.id, second, failed)
    store.removeSource(second.id)
    expect(store.getSnapshot().error).toBeNull()
  })

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
