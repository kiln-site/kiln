import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { createAppClients } from "@/lib/query-client"
import { queryKeys, type RelayConnection } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { FleetInstance, FleetNode } from "@/lib/realtime-events"
import {
  applyDeletedInstance,
  applyProvisioningInstance,
  applyRecoveredRelayConnection,
  applyRealtimeEvent,
  applyRealtimeEventSafely,
  applyRealtimeSnapshotEvent,
  applyUpdatedInstance,
  mergeRealtimeInstance,
  resetRealtimeEpoch,
} from "@/lib/realtime-client"

const epoch = "00000000-0000-4000-8000-000000000001"
const defaultBackupRunsKey = queryKeys.backups.runs({
  direction: "desc",
  scope: null,
  search: "",
  sort: "createdAt",
  status: null,
})
const targetSortedBackupRunsKey = queryKeys.backups.runs({
  direction: "asc",
  scope: null,
  search: "",
  sort: "target",
  status: null,
})

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

  it("reports collection write failures so the stream can recover", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    const onFailure = vi.fn()

    expect(
      applyRealtimeEventSafely(
        {
          event: {
            deleted: [],
            epoch,
            sequence: 1,
            type: "instances.delta",
            upserted: [beta],
          },
          instances: {
            isReady: () => true,
            utils: {
              writeBatch: () => {
                throw new Error("schema write failed")
              },
            },
          } as unknown as Parameters<typeof applyRealtimeEvent>[0]["instances"],
          queryClient,
        },
        onFailure
      )
    ).toBe(false)
    expect(onFailure).toHaveBeenCalledOnce()
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

  it("updates only the affected Relay reachability in place", () => {
    const current = snapshot()
    const result = applyRealtimeSnapshotEvent(current, {
      epoch,
      relayId: alpha.relayId,
      sequence: 1,
      status: "unreachable",
      type: "relay.status",
    })

    expect(result?.instances).toEqual([
      { ...alpha, relayStatus: "unreachable" },
    ])
    expect(result?.nodes).toEqual([{ ...node, relayStatus: "unreachable" }])
  })

  it("keeps Relay connection state and fleet rows in sync", () => {
    const queryClient = new QueryClient()
    const current = snapshot()
    queryClient.setQueryData(queryKeys.relay.snapshot, current)
    queryClient.setQueryData(queryKeys.relay.instances, current.instances)
    queryClient.setQueryData(queryKeys.relay.connection, {
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        { id: alpha.relayId, name: alpha.relayName, status: "connected" },
      ],
      snapshot: current,
      status: "connected",
    })
    const instances = {
      isReady: () => false,
    } as unknown as Parameters<typeof applyRealtimeEvent>[0]["instances"]

    applyRealtimeEvent({
      event: {
        epoch,
        relayId: alpha.relayId,
        sequence: 1,
        status: "unreachable",
        type: "relay.status",
      },
      instances,
      queryClient,
    })

    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relays: [{ id: alpha.relayId, status: "unreachable" }],
      status: "unreachable",
    })
    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances[0]?.relayStatus
    ).toBe("unreachable")

    applyRealtimeEvent({
      event: {
        epoch,
        relayId: alpha.relayId,
        sequence: 2,
        status: "connected",
        type: "relay.status",
      },
      instances,
      queryClient,
    })

    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relays: [{ id: alpha.relayId, status: "connected" }],
      status: "connected",
    })
  })

  it("keeps the Query cache synchronized through ready collection writes", async () => {
    const clients = createAppClients()
    const collectionAlpha = {
      ...alpha,
      containerId: null,
      desiredState: "running",
      directory: "/srv/instances/alpha",
      game: "Minecraft",
      implementation: "Paper",
      javaVersion: "21",
      observedState: "running",
      relayId: "r".repeat(43),
      routeId: `${"r".repeat(43)}-aaaaaaaa`,
      service: "alpha",
      status: "running",
      version: "1.21.8",
    } as FleetInstance
    clients.queryClient.setQueryData(queryKeys.relay.instances, [
      collectionAlpha,
    ])
    const instances = getRelayInstancesCollection(clients.dbClient)
    await instances.preload()

    applyRealtimeEvent({
      event: {
        epoch,
        relayId: collectionAlpha.relayId,
        sequence: 1,
        status: "unreachable",
        type: "relay.status",
      },
      instances,
      queryClient: clients.queryClient,
    })

    expect(
      instances.get(`${collectionAlpha.relayId}:${collectionAlpha.id}`)
    ).toMatchObject({
      relayStatus: "unreachable",
    })
    expect(
      clients.queryClient.getQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances
      )
    ).toEqual([{ ...collectionAlpha, relayStatus: "unreachable" }])
    await clients.dbClient.cleanup()
  })

  it("replaces connection membership during authoritative recovery", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.connection, {
      relay: { id: "stale-relay", name: "Stale Relay" },
      relays: [{ id: "stale-relay", name: "Stale Relay", status: "connected" }],
      snapshot: snapshot(),
      status: "connected",
    })

    await applyRecoveredRelayConnection(queryClient, {
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        {
          id: alpha.relayId,
          name: alpha.relayName,
          status: "connected",
        },
      ],
      snapshot: snapshot(),
      status: "connected",
    })

    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relays: [{ id: alpha.relayId, status: "connected" }],
      snapshot: snapshot(),
      status: "connected",
    })
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toEqual([alpha])

    await applyRecoveredRelayConnection(queryClient, {
      message: "No Relay has been configured yet.",
      relay: null,
      status: "unconfigured",
    })

    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relay: null,
      status: "unconfigured",
    })
    expect(queryClient.getQueryData(queryKeys.relay.snapshot)).toEqual({
      instances: [],
      nodes: [],
    })
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toEqual([])
  })

  it("cancels older Relay fetches before applying recovery", async () => {
    const queryClient = new QueryClient()
    let resolveStale!: (connection: {
      message: string
      relay: null
      status: "unconfigured"
    }) => void
    let resolveStaleSnapshot!: (snapshot: RelayFleetSnapshot) => void
    let resolveStaleInstances!: (instances: Array<FleetInstance>) => void
    const connectionFlight = queryClient.fetchQuery({
      queryKey: queryKeys.relay.connection,
      queryFn: () =>
        new Promise((resolve) => {
          resolveStale = resolve
        }),
      retry: false,
    })
    const snapshotFlight = queryClient.fetchQuery({
      queryKey: queryKeys.relay.snapshot,
      queryFn: () =>
        new Promise((resolve) => {
          resolveStaleSnapshot = resolve
        }),
      retry: false,
    })
    const instancesFlight = queryClient.fetchQuery({
      queryKey: queryKeys.relay.instances,
      queryFn: () =>
        new Promise((resolve) => {
          resolveStaleInstances = resolve
        }),
      retry: false,
    })

    await applyRecoveredRelayConnection(queryClient, {
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        {
          id: alpha.relayId,
          name: alpha.relayName,
          status: "connected",
        },
      ],
      snapshot: snapshot(),
      status: "connected",
    })
    resolveStale({
      message: "No Relay has been configured yet.",
      relay: null,
      status: "unconfigured",
    })
    resolveStaleSnapshot({ instances: [beta], nodes: [node] })
    resolveStaleInstances([beta])
    await Promise.allSettled([
      connectionFlight,
      instancesFlight,
      snapshotFlight,
    ])

    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relays: [{ id: alpha.relayId, status: "connected" }],
      status: "connected",
    })
    expect(queryClient.getQueryData(queryKeys.relay.snapshot)).toEqual(
      snapshot()
    )
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toEqual([alpha])
  })

  it("keeps fallback rows when recovery marks a Relay unreachable", async () => {
    const queryClient = new QueryClient()
    const unreachableSnapshot = {
      instances: [{ ...alpha, relayStatus: "unreachable" as const }],
      nodes: [{ ...node, relayStatus: "unreachable" as const }],
    }

    await applyRecoveredRelayConnection(queryClient, {
      message: "The Relay is configured, but Hearth cannot reach it right now.",
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        {
          id: alpha.relayId,
          name: alpha.relayName,
          status: "unreachable",
        },
      ],
      snapshot: unreachableSnapshot,
      status: "unreachable",
    })

    expect(queryClient.getQueryData(queryKeys.relay.instances)).toEqual(
      unreachableSnapshot.instances
    )
    expect(queryClient.getQueryData(queryKeys.relay.connection)).toMatchObject({
      relays: [{ id: alpha.relayId, status: "unreachable" }],
      status: "unreachable",
    })
  })

  it("ignores an SSE delete after an optimistic cache deletion", () => {
    const queryClient = new QueryClient()
    const writeDelete = vi.fn()

    applyRealtimeEvent({
      event: {
        deleted: [{ instanceId: alpha.id, relayId: alpha.relayId }],
        epoch,
        sequence: 1,
        type: "instances.delta",
        upserted: [],
      },
      instances: {
        has: () => false,
        isReady: () => true,
        utils: {
          writeBatch: (write: () => void) => write(),
          writeDelete,
        },
      } as unknown as Parameters<typeof applyRealtimeEvent>[0]["instances"],
      queryClient,
    })

    expect(writeDelete).not.toHaveBeenCalled()
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

  it("writes mutation responses to the normalized instance cache", () => {
    const queryClient = new QueryClient()
    const current = { instances: [alpha, beta], nodes: [node] }
    queryClient.setQueryData(queryKeys.relay.snapshot, current)
    queryClient.setQueryData(queryKeys.relay.instances, current.instances)

    applyUpdatedInstance(queryClient, { ...alpha, name: "Renamed" })

    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances
    ).toEqual([{ ...alpha, name: "Renamed" }, beta])
    expect(
      queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances)
    ).toEqual([{ ...alpha, name: "Renamed" }, beta])
  })

  it("invalidates only name-dependent backup results after a rename", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    queryClient.setQueryData(queryKeys.relay.instances, [alpha])
    queryClient.setQueryData(defaultBackupRunsKey, {
      pageParams: [null],
      pages: [],
    })
    queryClient.setQueryData(targetSortedBackupRunsKey, {
      pageParams: [null],
      pages: [],
    })

    applyUpdatedInstance(queryClient, { ...alpha, name: "Renamed" })
    await vi.waitFor(() => {
      expect(
        queryClient.getQueryState(targetSortedBackupRunsKey)?.isInvalidated
      ).toBe(true)
    })

    expect(queryClient.getQueryState(defaultBackupRunsKey)?.isInvalidated).toBe(
      false
    )
  })

  it("adds a newly provisioned row to every populated fleet cache", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    queryClient.setQueryData(queryKeys.relay.instances, [alpha])

    applyProvisioningInstance(queryClient, beta)

    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances
    ).toEqual([beta, alpha])
    expect(
      queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances)
    ).toEqual([beta, alpha])
  })

  it("removes a deleted row from every populated fleet cache", () => {
    const queryClient = new QueryClient()
    const current = { instances: [alpha, beta], nodes: [node] }
    queryClient.setQueryData(queryKeys.relay.snapshot, current)
    queryClient.setQueryData(queryKeys.relay.connection, {
      snapshot: current,
      status: "connected",
    })
    queryClient.setQueryData(queryKeys.relay.instances, current.instances)

    applyDeletedInstance(queryClient, {
      instanceId: alpha.id,
      relayId: alpha.relayId,
    })

    expect(
      queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
        ?.instances
    ).toEqual([beta])
    expect(
      queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances)
    ).toEqual([beta])
    expect(
      queryClient.getQueryData<{ snapshot: RelayFleetSnapshot }>(
        queryKeys.relay.connection
      )?.snapshot.instances
    ).toEqual([beta])
  })

  it("keeps an unreachable connection snapshot current", () => {
    const queryClient = new QueryClient()
    const current = snapshot()
    queryClient.setQueryData(queryKeys.relay.snapshot, current)
    queryClient.setQueryData(queryKeys.relay.connection, {
      message: "Relay unavailable",
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        {
          id: alpha.relayId,
          name: alpha.relayName,
          status: "unreachable",
        },
      ],
      snapshot: current,
      status: "unreachable",
    })
    const instances = {
      isReady: () => false,
    } as unknown as Parameters<typeof applyRealtimeEvent>[0]["instances"]
    const connectionInstances = () =>
      queryClient.getQueryData<
        Extract<RelayConnection, { status: "unreachable" }>
      >(queryKeys.relay.connection)?.snapshot.instances

    applyRealtimeEvent({
      event: {
        deleted: [{ instanceId: alpha.id, relayId: alpha.relayId }],
        epoch,
        sequence: 1,
        type: "instances.delta",
        upserted: [beta],
      },
      instances,
      queryClient,
    })
    expect(connectionInstances()).toEqual([beta])

    applyProvisioningInstance(queryClient, alpha)
    expect(connectionInstances()).toEqual([alpha, beta])

    applyDeletedInstance(queryClient, {
      instanceId: beta.id,
      relayId: beta.relayId,
    })
    expect(connectionInstances()).toEqual([alpha])
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
