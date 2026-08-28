import { describe, expect, it } from "vite-plus/test"
import type { QueryClient } from "@tanstack/react-query"

import { createAppClients } from "./query-client"
import {
  connectionWithCanonicalSnapshot,
  queryKeys,
  snapshotWithCanonicalState,
  type RelayConnection,
} from "./query-options"
import type { RelayFleetSnapshot } from "./relay-fleet"

describe("app data clients", () => {
  it("isolates Query and DB state by router request or browser session", async () => {
    const first = createAppClients()
    const second = createAppClients()

    expect(first.queryClient).not.toBe(second.queryClient)
    expect(first.dbClient).not.toBe(second.dbClient)
    expect(first.dbClient.requireDependency<QueryClient>("queryClient")).toBe(
      first.queryClient
    )
    expect(second.dbClient.requireDependency<QueryClient>("queryClient")).toBe(
      second.queryClient
    )

    await Promise.all([first.dbClient.cleanup(), second.dbClient.cleanup()])
  })

  it("never lets a connection refetch overwrite newer live fleet state", async () => {
    const clients = createAppClients()
    const live: RelayFleetSnapshot = { instances: [], nodes: [] }
    const cached: RelayFleetSnapshot = { instances: [], nodes: [] }
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, live)
    clients.queryClient.setQueryData(queryKeys.relay.instances, live.instances)

    const current = {
      snapshot: live,
      status: "connected",
    } as RelayConnection
    const fetched = {
      snapshot: cached,
      status: "connected",
    } as RelayConnection
    clients.queryClient.setQueryData(queryKeys.relay.connection, current)

    const resolved = connectionWithCanonicalSnapshot(
      clients.queryClient,
      fetched as Extract<RelayConnection, { status: "connected" }>
    )

    expect(clients.queryClient.getQueryData(queryKeys.relay.snapshot)).toBe(
      live
    )
    expect(clients.queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      live.instances
    )
    expect(resolved.snapshot).toBe(live)
    await clients.dbClient.cleanup()
  })

  it("never lets a snapshot refetch overwrite newer live fleet state", async () => {
    const clients = createAppClients()
    const live: RelayFleetSnapshot = { instances: [], nodes: [] }
    const fetched: RelayFleetSnapshot = { instances: [], nodes: [] }
    clients.queryClient.setQueryData(queryKeys.relay.snapshot, live)
    clients.queryClient.setQueryData(queryKeys.relay.connection, {
      snapshot: live,
      status: "connected",
    } as RelayConnection)

    const resolved = snapshotWithCanonicalState(clients.queryClient, fetched)

    expect(resolved).toBe(live)
    expect(clients.queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      live.instances
    )
    await clients.dbClient.cleanup()
  })

  it("keeps unreachable connection and fleet caches on one snapshot", async () => {
    const clients = createAppClients()
    const fallback: RelayFleetSnapshot = { instances: [], nodes: [] }
    const connection = {
      message: "Relay unavailable",
      relay: { id: "relay-a", name: "Relay A" },
      relays: [
        { id: "relay-a", name: "Relay A", status: "unreachable" },
      ],
      snapshot: fallback,
      status: "unreachable",
    } as Extract<RelayConnection, { status: "unreachable" }>

    const resolved = connectionWithCanonicalSnapshot(
      clients.queryClient,
      connection
    )

    expect(resolved.snapshot).toBe(fallback)
    expect(clients.queryClient.getQueryData(queryKeys.relay.snapshot)).toBe(
      fallback
    )
    expect(clients.queryClient.getQueryData(queryKeys.relay.instances)).toBe(
      fallback.instances
    )
    await clients.dbClient.cleanup()
  })
})
