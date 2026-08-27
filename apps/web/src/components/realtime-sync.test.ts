import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

import { queryKeys } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { FleetInstance, FleetNode } from "@/lib/realtime-events"
import {
  applyProvisioningInstance,
  applyRealtimeEvent,
  applyRealtimeSnapshotEvent,
  mergeRealtimeInstance,
  resetRealtimeEpoch,
} from "@/lib/realtime-client"

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

  it("updates Query caches without writing to an idle DB collection", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    queryClient.setQueryData(queryKeys.relay.instances, [alpha])
    const event = {
      deleted: [{ instanceId: alpha.id, relayId: alpha.relayId }],
      epoch,
      sequence: 1,
      type: "instances.delta" as const,
      upserted: [beta],
    }

    applyRealtimeEvent({
      event,
      instances: {
        isReady: () => false,
        utils: {
          writeBatch: () => {
            throw new Error("idle collections cannot accept manual writes")
          },
        },
      } as unknown as Parameters<typeof applyRealtimeEvent>[0]["instances"],
      queryClient,
    })

    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances
    ).toEqual([beta])
    expect(
      queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances)
    ).toEqual([beta])
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

  it("does not rebuild Relay state for a Hearth collection event", () => {
    const current = snapshot()
    const result = applyRealtimeSnapshotEvent(current, {
      epoch,
      sequence: 1,
      topics: ["relays"],
      type: "collections.invalidate",
    })

    expect(result).toBe(current)
  })

  it("forwards collection scope without touching Relay caches", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    const refreshTopics = vi.fn().mockResolvedValue(undefined)
    const scope = { instanceId: alpha.id, relayId: alpha.relayId }

    applyRealtimeEvent({
      event: {
        epoch,
        scope,
        sequence: 1,
        topics: ["file-activity"],
        type: "collections.invalidate",
      },
      instances: {} as Parameters<typeof applyRealtimeEvent>[0]["instances"],
      queryClient,
      refreshTopics,
    })

    expect(refreshTopics).toHaveBeenCalledWith(["file-activity"], scope)
    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
    ).toEqual(snapshot())
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

  it("reconciles only the active provisioning row into Relay caches", () => {
    const queryClient = new QueryClient()
    const provisioning = {
      ...alpha,
      provisioning: {
        attempt: 1,
        error: null,
        phase: "finalizing" as const,
      },
    }
    const current = { instances: [provisioning, beta], nodes: [node] }
    queryClient.setQueryData(queryKeys.relay.snapshot, current)
    queryClient.setQueryData(queryKeys.relay.instances, current.instances)

    applyProvisioningInstance(queryClient, { ...alpha, name: "Ready" })

    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances
    ).toEqual([{ ...alpha, name: "Ready" }, beta])
    expect(
      queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances)
    ).toEqual([{ ...alpha, name: "Ready" }, beta])
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
