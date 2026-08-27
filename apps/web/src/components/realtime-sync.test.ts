import { describe, expect, it } from "vite-plus/test"

import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { FleetInstance, FleetNode } from "@/lib/realtime-events"
import {
  applyRealtimeSnapshotEvent,
  mergeRealtimeInstance,
  resetRealtimeEpoch,
} from "./realtime-sync"

const epoch = "00000000-0000-4000-8000-000000000001"

const alpha = {
  connectAddress: "play.example.test",
  id: "a".repeat(40),
  name: "Alpha",
  publicHost: "127.0.0.1",
  publicPort: 25_565,
  relayId: "relay-a",
  relayName: "Relay A",
  relayStatus: "connected",
  routeId: "relay-a-aaaaaaaa",
  shortId: "a".repeat(8),
} as FleetInstance
const beta = {
  ...alpha,
  id: "b".repeat(40),
  name: "Beta",
  routeId: "relay-a-bbbbbbbb",
  shortId: "b".repeat(8),
} as FleetInstance
const node = {
  id: "node-a",
  name: "Relay node",
  relayId: "relay-a",
  relayName: "Relay A",
  relayStatus: "connected",
} as FleetNode

function snapshot(): RelayFleetSnapshot {
  return { instances: [alpha], nodes: [node] }
}

describe("realtime snapshot projection", () => {
  it("upserts and deletes only the affected instance rows", () => {
    const result = applyRealtimeSnapshotEvent(snapshot(), {
      deleted: [{ instanceId: alpha.id, relayId: alpha.relayId }],
      epoch,
      sequence: 1,
      type: "instances.delta",
      upserted: [beta],
    })

    expect(result?.instances).toEqual([beta])
    expect(result?.nodes).toEqual([node])
  })

  it("updates a node without rebuilding instance data", () => {
    const current = snapshot()
    const updatedNode = { ...node, name: "Renamed node" }
    const result = applyRealtimeSnapshotEvent(current, {
      epoch,
      nodes: [updatedNode],
      sequence: 1,
      type: "nodes.delta",
    })

    expect(result?.instances).toBe(current.instances)
    expect(result?.nodes).toEqual([updatedNode])
  })

  it("preserves Hearth's managed address for observation-only updates", () => {
    expect(
      mergeRealtimeInstance(alpha, {
        ...alpha,
        connectAddress: "127.0.0.1:25565",
        name: "Renamed",
      })
    ).toMatchObject({
      connectAddress: "play.example.test",
      name: "Renamed",
    })
  })

  it("clears optional Relay state when the authoritative row omits it", () => {
    expect(
      mergeRealtimeInstance(
        {
          ...alpha,
          provisioning: {
            attempt: 1,
            error: null,
            phase: "finalizing",
          },
        },
        alpha
      )
    ).not.toHaveProperty("provisioning")
  })

  it("drops an old sequence floor when the Hearth process epoch changes", () => {
    expect(
      resetRealtimeEpoch({
        currentEpoch: epoch,
        nextEpoch: "00000000-0000-4000-8000-000000000002",
        recoveryFloor: 10_000,
      })
    ).toEqual({
      changed: true,
      epoch: "00000000-0000-4000-8000-000000000002",
      recoveryFloor: 0,
    })
  })

  it("preserves the sequence floor within one Hearth process epoch", () => {
    expect(
      resetRealtimeEpoch({
        currentEpoch: epoch,
        nextEpoch: epoch,
        recoveryFloor: 42,
      })
    ).toEqual({
      changed: false,
      epoch,
      recoveryFloor: 42,
    })
  })
})
