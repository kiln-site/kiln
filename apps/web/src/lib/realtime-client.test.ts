import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { createAppClients, type AppRouterContext } from "@/lib/query-client"
import { queryKeys, type RelayConnection } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type {
  FleetInstance,
  FleetNode,
  RealtimeClientEvent,
} from "@/lib/realtime-events"
import {
  applyDeletedInstance,
  applyProvisioningInstance,
  applyRecoveredRelayConnection,
  applyRealtimeEventSafely,
  applyUpdatedInstance,
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
// A row that satisfies the Relay instances collection schema.
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
const node = {
  id: "node-a",
  name: "Relay node",
  relayId: "relay-a",
  relayName: "Relay A",
  relayStatus: "connected",
} as FleetNode

type StreamEvent = Exclude<
  RealtimeClientEvent,
  { type: "relay.invalidate" | "reset" }
>

const openClients: Array<AppRouterContext> = []

afterEach(async () => {
  await Promise.all(
    openClients.splice(0).map(({ dbClient }) => dbClient.cleanup())
  )
})

function snapshot(): RelayFleetSnapshot {
  return { instances: [alpha], nodes: [node] }
}

// The app's real clients with the Relay instances collection left idle, as it
// is until a route subscribes to it.
function fleet() {
  const clients = createAppClients()
  openClients.push(clients)
  return {
    instances: getRelayInstancesCollection(clients.dbClient),
    queryClient: clients.queryClient,
  }
}

// The same clients after a route has loaded the collection from `rows`.
async function readyFleet(rows: Array<FleetInstance>) {
  const clients = fleet()
  clients.queryClient.setQueryData(queryKeys.relay.instances, rows)
  await clients.instances.preload()
  return clients
}

function applyEvent(
  clients: ReturnType<typeof fleet>,
  event: StreamEvent,
  refreshTopics?: Parameters<
    typeof applyRealtimeEventSafely
  >[0]["refreshTopics"]
): void {
  let failure: unknown
  const applied = applyRealtimeEventSafely(
    { event, ...clients, refreshTopics },
    (cause) => {
      failure = cause
    }
  )
  if (!applied) throw failure
}

function instancesDelta(
  upserted: Array<FleetInstance>,
  deleted: Array<FleetInstance> = []
): StreamEvent {
  return {
    deleted: deleted.map(({ id, relayId }) => ({ instanceId: id, relayId })),
    epoch,
    sequence: 1,
    type: "instances.delta",
    upserted,
  }
}

function relayStatus(
  relayId: string,
  status: "connected" | "unreachable",
  sequence = 1
): StreamEvent {
  return { epoch, relayId, sequence, status, type: "relay.status" }
}

describe("realtime event application", () => {
  it("applies instance deltas to Query caches while the collection is idle", () => {
    const clients = fleet()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())
    clients.queryClient.setQueryData(queryKeys.relay.instances, [alpha])

    applyEvent(clients, instancesDelta([beta], [alpha]))

    expect(
      clients.queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
    ).toEqual({ instances: [beta], nodes: [node] })
    expect(
      clients.queryClient.getQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances
      )
    ).toEqual([beta])
  })

  it("reports collection write failures so the stream can recover", async () => {
    const clients = await readyFleet([collectionAlpha])
    const onFailure = vi.fn()

    // `beta` does not satisfy the collection schema, so the write throws.
    const applied = applyRealtimeEventSafely(
      { event: instancesDelta([beta]), ...clients },
      onFailure
    )

    expect(applied).toBe(false)
    expect(onFailure).toHaveBeenCalled()
  })

  it("ignores an SSE delete after an optimistic cache deletion", async () => {
    const clients = await readyFleet([])

    applyEvent(clients, instancesDelta([], [collectionAlpha]))

    expect(clients.instances.toArray).toEqual([])
  })

  it("keeps the Query cache synchronized through ready collection writes", async () => {
    const clients = await readyFleet([collectionAlpha])

    applyEvent(clients, relayStatus(collectionAlpha.relayId, "unreachable"))

    expect(
      clients.instances.get(`${collectionAlpha.relayId}:${collectionAlpha.id}`)
    ).toMatchObject({ relayStatus: "unreachable" })
    expect(
      clients.queryClient.getQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances
      )
    ).toEqual([{ ...collectionAlpha, relayStatus: "unreachable" }])
  })

  it("updates a node without rebuilding instance data", () => {
    const clients = fleet()
    const current = snapshot()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, current)
    const updatedNode = { ...node, name: "Renamed node" }

    applyEvent(clients, {
      epoch,
      nodes: [updatedNode],
      sequence: 1,
      type: "nodes.delta",
    })

    const result = clients.queryClient.getQueryData<RelayFleetSnapshot>(
      queryKeys.relay.snapshot
    )
    expect(result?.instances).toBe(current.instances)
    expect(result?.nodes).toEqual([updatedNode])
  })

  it("keeps Relay connection state and fleet rows in sync", () => {
    const clients = fleet()
    const current = snapshot()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, current)
    clients.queryClient.setQueryData(
      queryKeys.relay.instances,
      current.instances
    )
    clients.queryClient.setQueryData(queryKeys.relay.connection, {
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        { id: alpha.relayId, name: alpha.relayName, status: "connected" },
      ],
      snapshot: current,
      status: "connected",
    })

    applyEvent(clients, relayStatus(alpha.relayId, "unreachable"))

    expect(
      clients.queryClient.getQueryData(queryKeys.relay.connection)
    ).toMatchObject({
      relays: [{ id: alpha.relayId, status: "unreachable" }],
      status: "unreachable",
    })
    expect(
      clients.queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
    ).toEqual({
      instances: [{ ...alpha, relayStatus: "unreachable" }],
      nodes: [{ ...node, relayStatus: "unreachable" }],
    })

    applyEvent(clients, relayStatus(alpha.relayId, "connected", 2))

    expect(
      clients.queryClient.getQueryData(queryKeys.relay.connection)
    ).toMatchObject({
      relays: [{ id: alpha.relayId, status: "connected" }],
      status: "connected",
    })
  })

  it("refreshes Hearth topics without touching Relay caches", () => {
    const clients = fleet()
    const current = snapshot()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, current)
    const refreshTopics = vi.fn().mockResolvedValue(undefined)
    const scope = { instanceId: alpha.id, relayId: alpha.relayId }

    applyEvent(
      clients,
      {
        epoch,
        scope,
        sequence: 1,
        topics: ["file-activity"],
        type: "collections.invalidate",
      },
      refreshTopics
    )

    expect(refreshTopics).toHaveBeenCalledWith(["file-activity"], scope)
    expect(clients.queryClient.getQueryData(queryKeys.relay.snapshot)).toBe(
      current
    )
  })

  it("preserves Hearth's managed address for observation-only updates", () => {
    const clients = fleet()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, snapshot())

    applyEvent(
      clients,
      instancesDelta([
        { ...alpha, connectAddress: "127.0.0.1:25565", name: "Renamed" },
      ])
    )

    expect(
      clients.queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )?.instances
    ).toEqual([{ ...alpha, name: "Renamed" }])
  })

  it("clears optional Relay state when the authoritative row omits it", () => {
    const clients = fleet()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, {
      instances: [
        {
          ...alpha,
          provisioning: { attempt: 1, error: null, phase: "finalizing" },
        },
      ],
      nodes: [node],
    })

    applyEvent(clients, instancesDelta([alpha]))

    expect(
      clients.queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )?.instances
    ).toEqual([alpha])
  })

  it("keeps an unreachable connection snapshot current", () => {
    const clients = fleet()
    const current = snapshot()
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, current)
    clients.queryClient.setQueryData(queryKeys.relay.connection, {
      message: "Relay unavailable",
      relay: { id: alpha.relayId, name: alpha.relayName },
      relays: [
        { id: alpha.relayId, name: alpha.relayName, status: "unreachable" },
      ],
      snapshot: current,
      status: "unreachable",
    })
    const connectionInstances = () =>
      clients.queryClient.getQueryData<
        Extract<RelayConnection, { status: "unreachable" }>
      >(queryKeys.relay.connection)?.snapshot.instances

    applyEvent(clients, instancesDelta([beta], [alpha]))
    expect(connectionInstances()).toEqual([beta])

    applyProvisioningInstance(clients.queryClient, alpha)
    expect(connectionInstances()).toEqual([alpha, beta])

    applyDeletedInstance(clients.queryClient, {
      instanceId: beta.id,
      relayId: beta.relayId,
    })
    expect(connectionInstances()).toEqual([alpha])
  })
})

describe("authoritative Relay recovery", () => {
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
          browserOrigin: "https://relay.example.com",
          consoleTransport: null,
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
          browserOrigin: "https://relay.example.com",
          consoleTransport: null,
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
          browserOrigin: "https://relay.example.com",
          consoleTransport: null,
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

describe("mutation responses", () => {
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

  it("invalidates only name-dependent backup results after a rename", () => {
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

    expect(
      queryClient.getQueryState(targetSortedBackupRunsKey)?.isInvalidated
    ).toBe(true)
    expect(queryClient.getQueryState(defaultBackupRunsKey)?.isInvalidated).toBe(
      false
    )
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
})
