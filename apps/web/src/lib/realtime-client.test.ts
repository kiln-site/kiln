import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

// Observations are read from Hearth; tests decide what Hearth reports.
vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: vi.fn(),
}))
const relayServer = vi.hoisted(() => ({
  getRelayReachability: vi.fn(),
  getServerWorkspace: vi.fn(),
}))
vi.mock("@/server/relay", () => relayServer)

import { QueryObserver } from "@tanstack/react-query"
import type {
  InstanceInventoryRequest,
  InstanceInventoryResult,
} from "@workspace/contracts"
import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { instanceStateQueryOptions } from "@/lib/instance-state"
import { createAppClients, type AppRouterContext } from "@/lib/query-client"
import {
  queryKeys,
  relayReachabilityQueryOptions,
  type RelayConnection,
  type RelayReachability,
} from "@/lib/query-options"
import { getInstanceInventory } from "@/server/instance-inventory"
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
  fleetEventNeedsRecovery,
  recheckPushedState,
  resetRealtimeEpoch,
} from "@/lib/realtime-client"
import {
  ensureServerWorkspace,
  recheckServerWorkspaces,
  serverWorkspaceQueryOptions,
  type ServerWorkspace,
} from "@/lib/server-workspace"

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

// A reachability read in flight, as a route loader starts it. The test
// resolves each request Hearth receives.
function controlledReads(queryClient: QueryClient) {
  const pending: Array<(relays: RelayReachability) => void> = []
  relayServer.getRelayReachability.mockImplementation(
    () =>
      new Promise<RelayReachability>((resolve) => {
        pending.push(resolve)
      })
  )
  const first = queryClient.fetchQuery(relayReachabilityQueryOptions())
  return { first, pending }
}

const relayA = (status: "connected" | "unreachable") => [
  { id: "relay-a", name: "Relay A", status },
]

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

  it("leaves the fleet unloaded when nothing on the page reads it", () => {
    const clients = fleet()

    applyEvent(clients, instancesDelta([beta]))

    expect(
      clients.queryClient.getQueryData(queryKeys.relay.instances)
    ).toBeUndefined()
  })

  it("recovers a push that arrives while the fleet's first read is in flight", async () => {
    const clients = fleet()
    let resolveFirstRead!: (instances: Array<FleetInstance>) => void
    const firstRead = clients.queryClient.fetchQuery({
      queryKey: queryKeys.relay.instances,
      queryFn: () =>
        new Promise<Array<FleetInstance>>((resolve) => {
          resolveFirstRead = resolve
        }),
    })

    // The read began before this push, so it would overwrite the change.
    expect(
      fleetEventNeedsRecovery(
        clients.queryClient,
        clients.instances,
        instancesDelta([beta])
      )
    ).toBe(true)

    resolveFirstRead([alpha])
    await firstRead
    expect(
      fleetEventNeedsRecovery(
        clients.queryClient,
        clients.instances,
        instancesDelta([beta])
      )
    ).toBe(false)
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
    ).toEqual([
      { ...collectionAlpha, relayStatus: "unreachable", relayUpdating: false },
    ])
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

  it("rereads an observation whose first read began before a Relay status change", async () => {
    const answers: Array<(reachability: "connected" | "unreachable") => void> =
      []
    vi.mocked(getInstanceInventory).mockImplementation(
      (({ data }: { data: Array<InstanceInventoryRequest> }) =>
        new Promise<Array<InstanceInventoryResult>>((resolve) => {
          answers.push((reachability) =>
            resolve(
              data.map((request) => ({
                request,
                value: {
                  kind: request.reference.kind,
                  view: "status",
                  data: null,
                  observation: {
                    ...request.reference,
                    reachability,
                    runtime: null,
                    inventory: "unavailable",
                    updating: false,
                  },
                },
              }))
            )
          )
        })) as unknown as typeof getInstanceInventory
    )
    const clients = fleet()
    const observer = new QueryObserver(
      clients.queryClient,
      instanceStateQueryOptions({
        kind: "server",
        relayId: "relay-a",
        id: "a".repeat(40),
      })
    )
    const unsubscribe = observer.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(answers).toHaveLength(1))
      applyEvent(clients, relayStatus("relay-a", "unreachable"))
      // The first read answers with what it saw before the change.
      answers[0]!("connected")
      await vi.waitFor(() => expect(answers).toHaveLength(2))
      answers[1]!("unreachable")
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.reachability).toBe(
          "unreachable"
        )
      )
    } finally {
      unsubscribe()
    }
  })

  it("rechecks only the observations on a Relay whose reachability changed", async () => {
    const reachability = new Map([
      ["relay-a", "connected"],
      ["relay-b", "connected"],
    ])
    vi.mocked(getInstanceInventory).mockImplementation((async ({
      data,
    }: {
      data: Array<InstanceInventoryRequest>
    }) =>
      data.map((request): InstanceInventoryResult => ({
        request,
        value: {
          kind: request.reference.kind,
          view: "status",
          data: null,
          observation: {
            ...request.reference,
            reachability:
              reachability.get(request.reference.relayId) === "connected"
                ? "connected"
                : "unreachable",
            runtime: null,
            inventory: "available",
            updating: false,
          },
        },
      }))) as unknown as typeof getInstanceInventory)
    const clients = fleet()
    const observe = (relayId: string) => {
      const observer = new QueryObserver(
        clients.queryClient,
        instanceStateQueryOptions({
          kind: "database",
          relayId,
          id: "d".repeat(40),
        })
      )
      const unsubscribe = observer.subscribe(() => {})
      return { observer, unsubscribe }
    }
    const a = observe("relay-a")
    const b = observe("relay-b")
    try {
      await vi.waitFor(() => {
        expect(a.observer.getCurrentResult().data?.reachability).toBe(
          "connected"
        )
        expect(b.observer.getCurrentResult().data?.reachability).toBe(
          "connected"
        )
      })
      // Both Relays now drop, but only relay-a has said so.
      reachability.set("relay-a", "unreachable")
      reachability.set("relay-b", "unreachable")
      applyEvent(clients, relayStatus("relay-a", "unreachable"))
      await vi.waitFor(() =>
        expect(a.observer.getCurrentResult().data?.reachability).toBe(
          "unreachable"
        )
      )
      expect(b.observer.getCurrentResult().data?.reachability).toBe("connected")
    } finally {
      a.unsubscribe()
      b.unsubscribe()
    }
  })

  it("keeps a Relay status pushed while a reachability read is in flight", async () => {
    const clients = fleet()
    const reads = controlledReads(clients.queryClient)

    applyEvent(clients, relayStatus("relay-a", "unreachable"))
    // Hearth may have sampled the Relay before the push.
    reads.pending[0]!(relayA("connected"))

    await expect(reads.first).resolves.toEqual(relayA("unreachable"))
    expect(reads.pending).toHaveLength(1)
    expect(
      clients.queryClient.getQueryData(queryKeys.relay.reachability)
    ).toEqual(relayA("unreachable"))
  })

  it("trusts a reachability read that starts after a push", async () => {
    const clients = fleet()
    applyEvent(clients, relayStatus("relay-a", "unreachable"))
    const reads = controlledReads(clients.queryClient)

    reads.pending[0]!(relayA("connected"))

    await expect(reads.first).resolves.toEqual(relayA("connected"))
  })

  it("reads reachability again after a read that spans a stream gap", async () => {
    const clients = fleet()
    const reads = controlledReads(clients.queryClient)
    // A connection toast reads it.
    const observer = new QueryObserver(
      clients.queryClient,
      relayReachabilityQueryOptions()
    )
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      // Pushes may have been missed while the stream was down.
      recheckPushedState(clients.queryClient)
      reads.pending[0]!(relayA("connected"))
      await vi.waitFor(() => expect(reads.pending).toHaveLength(2))
      reads.pending[1]!(relayA("unreachable"))

      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toEqual(relayA("unreachable"))
      )
    } finally {
      unsubscribe()
    }
  })

  it("tells connection toasts when a Relay drops and returns", () => {
    const clients = fleet()
    clients.queryClient.setQueryData(queryKeys.relay.reachability, [
      { id: "relay-a", name: "Relay A", status: "connected" },
      { id: "relay-b", name: "Relay B", status: "connected" },
    ])
    applyEvent(clients, relayStatus("relay-a", "unreachable"))
    expect(
      clients.queryClient.getQueryData(queryKeys.relay.reachability)
    ).toEqual([
      { id: "relay-a", name: "Relay A", status: "unreachable" },
      { id: "relay-b", name: "Relay B", status: "connected" },
    ])
    applyEvent(clients, relayStatus("relay-a", "connected", 2))
    expect(
      clients.queryClient.getQueryData(queryKeys.relay.reachability)
    ).toMatchObject([{ id: "relay-a", status: "connected" }, {}])
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
      instances: [
        { ...alpha, relayStatus: "unreachable", relayUpdating: false },
      ],
      nodes: [{ ...node, relayStatus: "unreachable", relayUpdating: false }],
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
  it("rechecks game server observations that pushes may have missed", async () => {
    let reported: "unavailable" | "available" = "unavailable"
    vi.mocked(getInstanceInventory).mockImplementation((async ({
      data,
    }: {
      data: Array<InstanceInventoryRequest>
    }) =>
      data.map((request): InstanceInventoryResult => ({
        request,
        value: {
          kind: request.reference.kind,
          view: "status",
          data: null,
          observation: {
            ...request.reference,
            reachability: "connected",
            runtime: reported === "available" ? "running" : null,
            inventory: reported,
            updating: false,
          },
        },
      }))) as unknown as typeof getInstanceInventory)
    const queryClient = new QueryClient()
    const observer = new QueryObserver(
      queryClient,
      instanceStateQueryOptions({
        kind: "server",
        relayId: alpha.relayId,
        id: alpha.id,
      })
    )
    const unsubscribe = observer.subscribe(() => {})
    try {
      // Read while the reconnected Relay had not yet sent its snapshot.
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.inventory).toBe("unavailable")
      )
      reported = "available"
      await applyRecoveredRelayConnection(queryClient, {
        relay: { id: alpha.relayId, name: alpha.relayName },
        relays: [
          { id: alpha.relayId, name: alpha.relayName, status: "connected" },
        ],
        snapshot: snapshot(),
        status: "connected",
      } as RelayConnection)
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.runtime).toBe("running")
      )
    } finally {
      unsubscribe()
      queryClient.clear()
    }
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
          browserOrigin: "https://relay.example.com",
          consoleTransport: null,
          id: alpha.relayId,
          name: alpha.relayName,
          status: "connected",
          updating: false,
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
          updating: false,
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
          updating: false,
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

describe("game server pages", () => {
  const relayAState = {
    browserOrigin: "https://relay-a.example.test",
    consoleTransport: "direct",
    id: "relay-a",
    name: "Relay A",
    status: "connected",
    updating: false,
  } as const

  function foundPage(instance: FleetInstance): ServerWorkspace {
    return {
      relay: relayAState,
      routeIdentifier: instance.shortId,
      snapshot: { instances: [instance], nodes: [node] },
      status: "found",
    } as ServerWorkspace
  }

  // A page that has loaded its server, as its route leaves it.
  function openPage(clients: ReturnType<typeof fleet>) {
    const { queryKey } = serverWorkspaceQueryOptions(alpha.shortId)
    clients.queryClient.setQueryData(queryKey, foundPage(alpha))
    return () => clients.queryClient.getQueryData<ServerWorkspace>(queryKey)
  }

  it("keeps a page on its own server as pushed changes arrive", () => {
    const clients = fleet()
    const page = openPage(clients)

    applyEvent(clients, instancesDelta([{ ...alpha, name: "Alpha 2" }, beta]))

    expect(page()).toEqual(foundPage({ ...alpha, name: "Alpha 2" }))
  })

  it("learns that its server was deleted", () => {
    const clients = fleet()
    const page = openPage(clients)

    applyEvent(clients, instancesDelta([], [alpha]))

    expect(page()).toEqual({ status: "not-found" })
  })

  it("follows its Relay's reachability", () => {
    const clients = fleet()
    const page = openPage(clients)

    applyEvent(clients, relayStatus("relay-a", "unreachable"))

    expect(page()).toMatchObject({
      relay: { status: "unreachable" },
      snapshot: { instances: [{ relayStatus: "unreachable" }] },
    })
  })

  it("writes a mutation response to the page", () => {
    const clients = fleet()
    const page = openPage(clients)

    applyUpdatedInstance(clients.queryClient, { ...alpha, name: "Renamed" })

    expect(page()).toMatchObject({
      snapshot: { instances: [{ id: alpha.id, name: "Renamed" }] },
    })
  })

  // Reads Hearth receives, resolved by the test.
  function controlledPageReads() {
    const reads: Array<(workspace: ServerWorkspace) => void> = []
    relayServer.getServerWorkspace.mockImplementation(
      () =>
        new Promise<ServerWorkspace>((resolve) => {
          reads.push(resolve)
        })
    )
    return reads
  }

  it("replays changes pushed during a read onto its answer", async () => {
    const clients = fleet()
    const reads = controlledPageReads()
    const read = clients.queryClient.fetchQuery(
      serverWorkspaceQueryOptions(alpha.shortId)
    )
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([{ ...alpha, name: "Alpha 2" }]))
    applyEvent(clients, instancesDelta([{ ...alpha, name: "Alpha 3" }]))
    // Hearth answered from before both pushes.
    reads[0]!(foundPage(alpha))
    await read

    expect(
      clients.queryClient.getQueryData(
        serverWorkspaceQueryOptions(alpha.shortId).queryKey
      )
    ).toEqual(foundPage({ ...alpha, name: "Alpha 3" }))
    expect(reads).toHaveLength(1)
  })

  it("keeps a deletion pushed during a read", async () => {
    const clients = fleet()
    const reads = controlledPageReads()
    const read = clients.queryClient.fetchQuery(
      serverWorkspaceQueryOptions(alpha.shortId)
    )
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([beta]))
    applyEvent(clients, instancesDelta([], [alpha]))
    reads[0]!(foundPage(alpha))
    await read

    expect(
      clients.queryClient.getQueryData(
        serverWorkspaceQueryOptions(alpha.shortId).queryKey
      )
    ).toEqual({ status: "not-found" })
  })

  it("reads again when a navigation's read spans a gap in pushed changes", async () => {
    const clients = fleet()
    const reads = controlledPageReads()
    // The route waits on this read, so it must settle, not be cancelled.
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    const recheck = recheckServerWorkspaces(clients.queryClient)
    reads[0]!(foundPage(alpha))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!(foundPage({ ...alpha, name: "Missed rename" }))

    await expect(navigation).resolves.toEqual(
      foundPage({ ...alpha, name: "Missed rename" })
    )
    await recheck
  })

  it("keeps a deletion pushed after a read answered but before it is stored", async () => {
    const clients = fleet()
    let answer!: (workspace: ServerWorkspace) => void
    const answered = new Promise<ServerWorkspace>((resolve) => {
      answer = resolve
    })
    relayServer.getServerWorkspace.mockReturnValue(answered)
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)
    await vi.waitFor(() =>
      expect(relayServer.getServerWorkspace).toHaveBeenCalled()
    )

    answer(foundPage(alpha))
    // Runs after the read's own code has seen the answer, before the query
    // stores it.
    await answered
    applyEvent(clients, instancesDelta([], [alpha]))

    await expect(navigation).resolves.toEqual({ status: "not-found" })
    expect(
      clients.queryClient.getQueryData(
        serverWorkspaceQueryOptions(alpha.shortId).queryKey
      )
    ).toEqual({ status: "not-found" })
  })

  it("keeps a page marked for resolution through later updates", async () => {
    const clients = fleet()
    openPage(clients)
    relayServer.getServerWorkspace.mockResolvedValue({ status: "not-found" })

    // The gap may have hidden this server's deletion.
    await recheckServerWorkspaces(clients.queryClient)
    applyEvent(clients, instancesDelta([beta]))
    applyEvent(clients, instancesDelta([{ ...alpha, name: "Alpha 2" }]))

    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.shortId)
    ).resolves.toEqual({ status: "not-found" })
  })

  it("resolves again when another server takes its short ID during the first read", async () => {
    const clients = fleet()
    const reads = controlledPageReads()
    const twin = { ...beta, shortId: alpha.shortId } as FleetInstance
    const read = clients.queryClient.fetchQuery(
      serverWorkspaceQueryOptions(alpha.shortId)
    )
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([twin]))
    reads[0]!(foundPage(alpha))
    await read
    relayServer.getServerWorkspace.mockResolvedValue({ status: "ambiguous" })

    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.shortId)
    ).resolves.toEqual({ status: "ambiguous" })
  })

  it("resolves a shown page again when another server takes its short ID mid-read", async () => {
    const clients = fleet()
    const page = openPage(clients)
    const reads = controlledPageReads()
    const twin = { ...beta, shortId: alpha.shortId } as FleetInstance
    const observer = new QueryObserver(
      clients.queryClient,
      serverWorkspaceQueryOptions(alpha.shortId)
    )
    const unsubscribe = observer.subscribe(() => undefined)
    void observer.refetch()
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([twin]))
    reads[0]!(foundPage(alpha))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!({ status: "ambiguous" })

    await vi.waitFor(() => expect(page()).toEqual({ status: "ambiguous" }))
    unsubscribe()
  })

  // Each read Hearth receives, answered by the test. `answered` settles
  // after the read's own code has seen the answer, before the query stores it.
  function stagedPageReads() {
    const reads: Array<{
      answer: (workspace: ServerWorkspace) => void
      answered: Promise<ServerWorkspace>
      fail: (cause: Error) => void
    }> = []
    relayServer.getServerWorkspace.mockImplementation(() => {
      let answer!: (workspace: ServerWorkspace) => void
      let fail!: (cause: Error) => void
      const answered = new Promise<ServerWorkspace>((resolve, reject) => {
        answer = resolve
        fail = reject
      })
      reads.push({ answer, answered, fail })
      return answered
    })
    return reads
  }

  it("does not open a server whose short ID another server took during the read", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const twin = { ...beta, shortId: alpha.shortId } as FleetInstance
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([twin]))
    reads[0]!.answer(foundPage(alpha))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer({ status: "ambiguous" })

    await expect(navigation).resolves.toEqual({ status: "ambiguous" })
  })

  it("opens a server created while a missing answer is stored", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    reads[0]!.answer({ status: "not-found" })
    await reads[0]!.answered
    applyEvent(clients, instancesDelta([alpha]))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer(foundPage(alpha))

    await expect(navigation).resolves.toEqual(foundPage(alpha))
  })

  it("keeps a missing answer when an unrelated server is pushed", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([beta]))
    reads[0]!.answer({ status: "not-found" })

    await expect(navigation).resolves.toEqual({ status: "not-found" })
    expect(reads).toHaveLength(1)
  })

  it("fails recovery when the reread a gap requires fails", async () => {
    const clients = fleet()
    openPage(clients)
    const reads = stagedPageReads()
    const observer = new QueryObserver(clients.queryClient, {
      ...serverWorkspaceQueryOptions(alpha.shortId),
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    void observer.refetch().catch(() => undefined)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    // The gap begins after Hearth answered, before the answer is stored.
    reads[0]!.answer(foundPage(alpha))
    await reads[0]!.answered
    const recheck = recheckServerWorkspaces(clients.queryClient)
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.fail(new Error("Hearth is restarting"))

    await expect(recheck).rejects.toThrow("Hearth is restarting")
    unsubscribe()
  })

  it("does not open a server by a name another server took during the read", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.name)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([{ ...beta, name: alpha.name }]))
    reads[0]!.answer(foundPage(alpha))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer({ status: "ambiguous" })

    await expect(navigation).resolves.toEqual({ status: "ambiguous" })
  })

  it("does not open a server by a name it was renamed away from during the read", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.name)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([{ ...alpha, name: "Renamed" }]))
    reads[0]!.answer(foundPage(alpha))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer({ status: "not-found" })

    await expect(navigation).resolves.toEqual({ status: "not-found" })
  })

  it("resolves an ambiguous name again when one match is renamed away", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.name)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([{ ...beta, name: "Beta again" }]))
    reads[0]!.answer({ status: "ambiguous" })
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer(foundPage(alpha))

    await expect(navigation).resolves.toEqual(foundPage(alpha))
  })

  it("fails a navigation whose reads never settle rather than guess", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.shortId)

    for (let read = 1; read <= 10; read += 1) {
      await vi.waitFor(() => expect(reads).toHaveLength(read))
      // Every read spans a gap in pushed changes.
      await recheckServerWorkspaces(clients.queryClient)
      reads[read - 1]!.answer(foundPage(alpha))
    }

    await expect(navigation).rejects.toThrow("kept changing")
  })

  it("rereads a mounted page after a gap in pushed changes", async () => {
    const clients = fleet()
    const page = openPage(clients)
    const observer = new QueryObserver(
      clients.queryClient,
      serverWorkspaceQueryOptions(alpha.shortId)
    )
    const unsubscribe = observer.subscribe(() => undefined)
    relayServer.getServerWorkspace.mockResolvedValue(
      foundPage({ ...alpha, name: "Missed rename" })
    )

    await recheckServerWorkspaces(clients.queryClient)

    expect(page()).toEqual(foundPage({ ...alpha, name: "Missed rename" }))
    unsubscribe()
  })

  it("fails a recheck whose reread fails, so recovery retries", async () => {
    const clients = fleet()
    openPage(clients)
    const observer = new QueryObserver(clients.queryClient, {
      ...serverWorkspaceQueryOptions(alpha.shortId),
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    relayServer.getServerWorkspace.mockRejectedValue(new Error("offline"))

    await expect(recheckServerWorkspaces(clients.queryClient)).rejects.toThrow(
      "offline"
    )
    unsubscribe()
  })

  it("resolves a navigation again after a gap marked its page stale", async () => {
    const clients = fleet()
    openPage(clients)
    relayServer.getServerWorkspace.mockResolvedValue({ status: "not-found" })

    // Nothing shows the page, so the recheck only marks it stale.
    await recheckServerWorkspaces(clients.queryClient)

    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.shortId)
    ).resolves.toEqual({ status: "not-found" })
  })

  it("reuses a page a navigation names by ID, but not by name", async () => {
    const clients = fleet()
    openPage(clients)
    const { queryKey } = serverWorkspaceQueryOptions(alpha.name)
    clients.queryClient.setQueryData(queryKey, foundPage(alpha))
    relayServer.getServerWorkspace.mockResolvedValue(foundPage(beta))

    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.shortId)
    ).resolves.toEqual(foundPage(alpha))
    // The name may belong to another server by now.
    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.name)
    ).resolves.toEqual(foundPage(beta))
  })

  it("resolves a page again when another server takes its short ID", async () => {
    const clients = fleet()
    openPage(clients)
    const twin = { ...beta, shortId: alpha.shortId } as FleetInstance
    relayServer.getServerWorkspace.mockResolvedValue({ status: "ambiguous" })

    applyEvent(clients, instancesDelta([twin]))

    await expect(
      ensureServerWorkspace(clients.queryClient, alpha.shortId)
    ).resolves.toEqual({ status: "ambiguous" })
  })
})
