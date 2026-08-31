import { describe, expect, it } from "vite-plus/test"
import {
  relayInstanceSchema,
  relayNodeSchema,
  type RelayNode,
} from "@workspace/contracts"

import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { selectTailscaleServers } from "@/lib/tailscale-selectors"

describe("Tailscale server selectors", () => {
  it("marks servers eligible only when their Relay supports staged stacks", () => {
    const supported = selectTailscaleServers(
      fleetSnapshot(["tailscale-stacks", "tailscale-staged-removal"])
    )
    const legacy = selectTailscaleServers(fleetSnapshot(["tailscale-stacks"]))
    const unsupported = selectTailscaleServers(fleetSnapshot())

    expect(supported[0]?.tailscaleSupported).toBe(true)
    expect(supported[0]).toMatchObject({
      observedState: "running",
      relayStatus: "connected",
    })
    expect(legacy[0]?.tailscaleSupported).toBe(false)
    expect(unsupported[0]?.tailscaleSupported).toBe(false)
  })
})

function fleetSnapshot(
  capabilities?: RelayNode["capabilities"]
): RelayFleetSnapshot {
  const relayId = "a".repeat(32)
  const relayName = "Test Relay"
  const instance = relayInstanceSchema.parse({
    connectAddress: "test.example:25565",
    containerId: "container",
    desiredState: "running",
    directory: "test-server",
    game: "Minecraft",
    id: "b".repeat(40),
    implementation: "Paper",
    javaVersion: "21",
    name: "Test server",
    observedState: "running",
    service: "test-server",
    shortId: "bbbbbbbb",
    status: "running",
    version: "1.21.11",
  })
  const node = relayNodeSchema.parse({
    arch: "arm64",
    ...(capabilities ? { capabilities } : {}),
    connectedAt: "2026-07-27T12:00:00.000Z",
    cpu: { cores: 8, loadPercent: 1 },
    docker: { available: true, version: "28.0.0" },
    id: "test-node",
    memory: { totalBytes: 1_000, usedBytes: 100 },
    name: relayName,
    platform: "darwin",
    storage: { totalBytes: 1_000, usedBytes: 100 },
    version: "0.1.0",
  })

  return {
    instances: [
      {
        ...instance,
        relayId,
        relayName,
        relayStatus: "connected",
        routeId: `${relayId}-${instance.shortId}`,
      },
    ],
    nodes: [
      {
        ...node,
        relayId,
        relayName,
        relayStatus: "connected",
      },
    ],
  }
}
