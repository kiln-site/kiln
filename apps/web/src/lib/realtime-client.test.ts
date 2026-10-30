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

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { createAppClients, type AppRouterContext } from "@/lib/query-client"
import type {
  FleetInstance,
  FleetNode,
  RealtimeClientEvent,
} from "@/lib/realtime-events"
import { applyRealtimeEventSafely } from "@/lib/realtime-client"
import {
  ensureServerWorkspace,
  type ServerWorkspace,
} from "@/lib/server-workspace"

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

function applyEvent(clients: ReturnType<typeof fleet>, event: StreamEvent) {
  let failure: unknown
  const applied = applyRealtimeEventSafely({ event, ...clients }, (cause) => {
    failure = cause
  })
  if (!applied) throw failure
}

function instancesDelta(upserted: Array<FleetInstance>): StreamEvent {
  return {
    deleted: [],
    epoch,
    sequence: 1,
    type: "instances.delta",
    upserted,
  }
}

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

  // Each read Hearth receives, answered by the test.
  function stagedPageReads() {
    const reads: Array<{
      answer: (workspace: ServerWorkspace) => void
      answered: Promise<ServerWorkspace>
    }> = []
    relayServer.getServerWorkspace.mockImplementation(() => {
      let answer!: (workspace: ServerWorkspace) => void
      const answered = new Promise<ServerWorkspace>((resolve) => {
        answer = resolve
      })
      reads.push({ answer, answered })
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
})
