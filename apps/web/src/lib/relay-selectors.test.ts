import { describe, expect, it } from "vite-plus/test"
import type { RelayInstance, RelaySnapshot } from "@workspace/contracts"

import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { findRelayInstance, resolveRelayInstance } from "@/lib/relay-selectors"

const instance = {
  connectAddress: "minecraft.test:25565",
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Fabric",
  javaVersion: "21",
  name: "Test server",
  observedState: "running",
  resources: {
    sampledAt: "2026-07-20T12:00:00.000Z",
    cpu: { percent: 12 },
    memory: { percent: 25, totalBytes: 100, usedBytes: 25 },
    storage: { percent: 40, totalBytes: 100, usedBytes: 40 },
  },
  service: "test-server",
  shortId: "aaaaaaaa",
  lifecycle: [
    { state: "started", time: "2026-07-20T11:00:00.000Z" },
    { state: "ready", time: "2026-07-20T11:00:15.000Z" },
  ],
  version: "1.21.11",
} as RelayInstance

function snapshotWithCpu(percent: number): RelayFleetSnapshot {
  return {
    instances: [
      {
        ...instance,
        relayId: "relay-one",
        relayName: "Relay one",
        relayStatus: "connected",
        routeId: "relay-one-aaaaaaaa",
        resources: {
          ...instance.resources!,
          sampledAt: `2026-07-20T12:00:0${percent}.000Z`,
          cpu: { capacityPercent: 400, percent },
        },
      },
    ],
    nodes: [
      {
        ...({} as RelaySnapshot["node"]),
        relayId: "relay-one",
        relayName: "Relay one",
        relayStatus: "connected",
      },
    ],
  }
}

describe("Relay render selectors", () => {
  it("does not select the first server when accessible short IDs collide", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const snapshot = snapshotWithCpu(1)
    snapshot.instances.push({
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    })

    expect(findRelayInstance(snapshot.instances, first.shortId)).toBeUndefined()
    expect(resolveRelayInstance(snapshot.instances, first.shortId)).toEqual({
      status: "ambiguous",
    })
  })
})
