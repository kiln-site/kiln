import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const relayServer = vi.hoisted(() => ({
  connection: vi.fn(),
  snapshot: vi.fn(),
}))

vi.mock("@/server/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/relay")>()),
  getRelayConnectionState: relayServer.connection,
  getRelaySnapshot: relayServer.snapshot,
}))

import { createAppClients } from "./query-client"
import {
  queryKeys,
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
  type RelayConnection,
} from "./query-options"
import type { RelayFleetSnapshot } from "./relay-fleet"

const clients: Array<ReturnType<typeof createAppClients>> = []

function appClients() {
  const created = createAppClients()
  clients.push(created)
  return created
}

afterEach(async () => {
  relayServer.connection.mockReset()
  relayServer.snapshot.mockReset()
  await Promise.all(clients.splice(0).map(({ dbClient }) => dbClient.cleanup()))
})

describe("app data clients", () => {
  it("never lets a connection refetch overwrite newer live fleet state", async () => {
    const { queryClient } = appClients()
    const live: RelayFleetSnapshot = { instances: [], nodes: [] }
    const cached: RelayFleetSnapshot = { instances: [], nodes: [] }
    queryClient.setQueryData(queryKeys.relay.snapshot, live)
    queryClient.setQueryData(queryKeys.relay.instances, live.instances)
    queryClient.setQueryData(queryKeys.relay.connection, {
      snapshot: live,
      status: "connected",
    } as RelayConnection)
    relayServer.connection.mockResolvedValue({
      snapshot: cached,
      status: "connected",
    })

    const resolved = await queryClient.fetchQuery({
      ...relayConnectionQueryOptions(queryClient),
      staleTime: 0,
    })

    expect(queryClient.getQueryData(queryKeys.relay.snapshot)).toBe(live)
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      live.instances
    )
    expect(resolved.status === "connected" && resolved.snapshot).toBe(live)
  })

  it("never lets a snapshot refetch overwrite newer live fleet state", async () => {
    const { queryClient } = appClients()
    const live: RelayFleetSnapshot = { instances: [], nodes: [] }
    const fetched: RelayFleetSnapshot = { instances: [], nodes: [] }
    queryClient.setQueryData(queryKeys.relay.snapshot, live)
    queryClient.setQueryData(queryKeys.relay.connection, {
      snapshot: live,
      status: "connected",
    } as RelayConnection)
    relayServer.snapshot.mockResolvedValue(fetched)

    const resolved = await queryClient.fetchQuery({
      ...relaySnapshotQueryOptions(),
      staleTime: 0,
    })

    expect(resolved).toBe(live)
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      live.instances
    )
  })

  it("keeps unreachable connection and fleet caches on one snapshot", async () => {
    const { queryClient } = appClients()
    const fallback: RelayFleetSnapshot = { instances: [], nodes: [] }
    relayServer.connection.mockResolvedValue({
      message: "Relay unavailable",
      relay: { id: "relay-a", name: "Relay A" },
      relays: [{ id: "relay-a", name: "Relay A", status: "unreachable" }],
      snapshot: fallback,
      status: "unreachable",
    })

    const resolved = await queryClient.fetchQuery(
      relayConnectionQueryOptions(queryClient)
    )

    expect(resolved.status === "unreachable" && resolved.snapshot).toBe(
      fallback
    )
    expect(queryClient.getQueryData(queryKeys.relay.snapshot)).toBe(fallback)
    expect(queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      fallback.instances
    )
  })
})
