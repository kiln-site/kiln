import { afterEach, expect, it, vi } from "vite-plus/test"

// Hearth's server functions are the network boundary; tests decide what the
// authoritative fleet read returns.
const relay = vi.hoisted(() => ({
  getFreshRelayConnectionState: vi.fn(),
  getRelayProxyModes: vi.fn(),
  getServerWorkspace: vi.fn(),
}))
vi.mock("@/server/relay", () => relay)
const relays = vi.hoisted(() => ({ getRelayWebRoutes: vi.fn() }))
vi.mock("@/server/relays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/relays")>()),
  ...relays,
}))
vi.mock("@/server/instance-inventory", () => ({
  getInstanceInventory: vi.fn(),
}))

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { createAppClients, type AppRouterContext } from "@/lib/query-client"
import {
  queryKeys,
  relayProxyModesQueryOptions,
  relayWebRoutesQueryOptions,
  type RelayConnection,
} from "@/lib/query-options"
import type { FleetInstance } from "@/lib/realtime-events"
import { startRealtimeSync } from "@/lib/realtime-sync"
import {
  serverWorkspaceQueryOptions,
  type ServerWorkspace,
} from "@/lib/server-workspace"
import { QueryObserver } from "@tanstack/react-query"

const epoch = "00000000-0000-4000-8000-000000000001"
const relayId = "r".repeat(43)
const row = {
  connectAddress: "play.example.test",
  containerId: null,
  desiredState: "running",
  directory: "/srv/instances/alpha",
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  name: "Alpha",
  observedState: "running",
  publicHost: "127.0.0.1",
  publicPort: 25_565,
  relayId,
  relayName: "Relay A",
  relayStatus: "connected",
  routeId: `${relayId}-aaaaaaaa`,
  service: "alpha",
  shortId: "a".repeat(8),
  status: "running",
  version: "1.21.8",
} as FleetInstance

// The browser's stream, driven by the test.
class FakeEventSource {
  static current: FakeEventSource | null = null
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  constructor() {
    FakeEventSource.current = this
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  close() {}
  emit(data: object) {
    const event = new MessageEvent("kiln", { data: JSON.stringify(data) })
    for (const listener of this.listeners.get("kiln") ?? []) listener(event)
  }
}
vi.stubGlobal("EventSource", FakeEventSource)

const openClients: Array<AppRouterContext> = []
afterEach(async () => {
  await Promise.all(
    openClients.splice(0).map(({ dbClient }) => dbClient.cleanup())
  )
  relay.getFreshRelayConnectionState.mockReset()
  relay.getRelayProxyModes.mockReset()
  relay.getServerWorkspace.mockReset()
  relays.getRelayWebRoutes.mockReset()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

it("keeps pushes, and directory changes sharing their sequence, that land while the fleet first loads", async () => {
  const clients = createAppClients()
  openClients.push(clients)
  const { queryClient } = clients
  // Navigation reads the game server directory.
  queryClient.setQueryData(queryKeys.servers.directory, [])
  const stop = startRealtimeSync(
    queryClient,
    getRelayInstancesCollection(clients.dbClient)
  )
  const stream = FakeEventSource.current!
  try {
    stream.emit({
      clear: false,
      epoch,
      hearth: false,
      sequence: 1,
      type: "reset",
    })
    await settle()

    // A page starts reading the fleet; the read samples before the push.
    let resolveFirstRead!: (instances: Array<FleetInstance>) => void
    const firstRead = queryClient.fetchQuery({
      queryKey: queryKeys.relay.instances,
      queryFn: () =>
        new Promise<Array<FleetInstance>>((resolve) => {
          resolveFirstRead = resolve
        }),
    })
    relay.getFreshRelayConnectionState.mockResolvedValue({
      relay: { id: relayId, name: "Relay A" },
      relays: [
        {
          browserOrigin: "https://relay.example.com",
          consoleTransport: null,
          id: relayId,
          name: "Relay A",
          status: "connected",
          updating: false,
        },
      ],
      snapshot: { instances: [row], nodes: [] },
      status: "connected",
    } satisfies RelayConnection)
    stream.emit({
      deleted: [],
      epoch,
      sequence: 2,
      type: "instances.delta",
      upserted: [row],
    })
    stream.emit({
      epoch,
      sequence: 2,
      topics: ["instance-directory"],
      type: "collections.invalidate",
    })
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.relay.instances)).toMatchObject(
        [{ id: row.id }]
      )
    )
    resolveFirstRead([])
    await firstRead.catch(() => undefined)
    await settle()

    expect(queryClient.getQueryData(queryKeys.relay.instances)).toMatchObject([
      { id: row.id },
    ])
    expect(
      queryClient.getQueryState(queryKeys.servers.directory)?.isInvalidated
    ).toBe(true)
  } finally {
    stop()
  }
})

it("retries recovery until an open game server page has been read again", async () => {
  const clients = createAppClients()
  openClients.push(clients)
  const { queryClient } = clients
  const page = (name: string) =>
    ({
      relay: {
        browserOrigin: "https://relay.example.com",
        consoleTransport: "direct",
        id: relayId,
        name: "Relay A",
        status: "connected",
        updating: false,
      },
      routeIdentifier: row.shortId,
      snapshot: { instances: [{ ...row, name }], nodes: [] },
      status: "found",
    }) as ServerWorkspace
  const options = { ...serverWorkspaceQueryOptions(row.shortId), retry: false }
  queryClient.setQueryData(options.queryKey, page("Alpha"))
  const unsubscribe = new QueryObserver(queryClient, options).subscribe(
    () => undefined
  )
  // The page shows the server; a rename is missed while the stream is away.
  relay.getServerWorkspace
    .mockRejectedValueOnce(new Error("Hearth is restarting"))
    .mockResolvedValue(page("Missed rename"))
  const stop = startRealtimeSync(
    queryClient,
    getRelayInstancesCollection(clients.dbClient)
  )
  try {
    FakeEventSource.current!.emit({
      clear: false,
      epoch,
      hearth: false,
      sequence: 1,
      type: "reset",
    })

    await vi.waitFor(
      () =>
        expect(queryClient.getQueryData(options.queryKey)).toEqual(
          page("Missed rename")
        ),
      { timeout: 3_000 }
    )
    expect(relay.getServerWorkspace).toHaveBeenCalledTimes(2)
  } finally {
    stop()
    unsubscribe()
  }
})

it.each([
  ["have settled", false],
  ["are still in flight", true],
])(
  "rereads a Relay's proxy for the map once its snapshot lands after a reconnect, when its first reads %s",
  async (_case, inFlight) => {
    const clients = createAppClients()
    openClients.push(clients)
    const { queryClient } = clients
    const stop = startRealtimeSync(
      queryClient,
      getRelayInstancesCollection(clients.dbClient)
    )
    const stream = FakeEventSource.current!
    const observers: Array<() => void> = []
    try {
      stream.emit({
        clear: false,
        epoch,
        hearth: false,
        sequence: 1,
        type: "reset",
      })
      await settle()

      // The map opens while the Relay is away: no snapshot has reported its
      // proxy yet, and its routes cannot be read. Those first answers can
      // arrive before the Relay is back, or only after.
      let answerFirstReads!: () => void
      const firstReads = new Promise<void>((resolve) => {
        answerFirstReads = resolve
      })
      if (!inFlight) answerFirstReads()
      relay.getRelayProxyModes
        .mockImplementationOnce(() =>
          firstReads.then(() => [{ mode: null, relayId }])
        )
        .mockResolvedValue([{ mode: "traefik", relayId }])
      relays.getRelayWebRoutes
        .mockImplementationOnce(() =>
          firstReads.then(() => Promise.reject(new Error("Relay is offline")))
        )
        .mockResolvedValue([
          {
            hostname: "map.example.test",
            id: "one",
            owner: { id: row.id, kind: "server", service: null },
            path: null,
          },
        ])
      const modes = new QueryObserver(
        queryClient,
        relayProxyModesQueryOptions()
      )
      const routes = new QueryObserver(
        queryClient,
        relayWebRoutesQueryOptions(relayId)
      )
      observers.push(
        modes.subscribe(() => undefined),
        routes.subscribe(() => undefined)
      )
      if (!inFlight)
        await vi.waitFor(() => {
          expect(modes.getCurrentResult().data).toEqual([
            { mode: null, relayId },
          ])
          expect(routes.getCurrentResult().status).toBe("error")
        })

      // It reconnects, then pushes the snapshot that carries its proxy.
      stream.emit({
        epoch,
        relayId,
        sequence: 2,
        status: "connected",
        type: "relay.status",
      })
      stream.emit({ epoch, sequence: 3, type: "relay.invalidate" })
      await settle()
      answerFirstReads()

      await vi.waitFor(() => {
        expect(modes.getCurrentResult().data).toEqual([
          { mode: "traefik", relayId },
        ])
        expect(
          routes.getCurrentResult().data?.map((route) => route.hostname)
        ).toEqual(["map.example.test"])
      })
      await settle()
      expect(modes.getCurrentResult().data).toEqual([
        { mode: "traefik", relayId },
      ])
    } finally {
      for (const unsubscribe of observers) unsubscribe()
      stop()
    }
  }
)
