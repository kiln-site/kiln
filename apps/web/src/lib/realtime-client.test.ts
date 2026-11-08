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

import { getRelayServersCollection } from "@/lib/collections/relay-servers"
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
  id: "a".repeat(12),
  name: "Alpha",
  publicHost: "127.0.0.1",
  publicPort: 25_565,
  relayId: "1".repeat(12),
  relayName: "Relay A",
  relayStatus: "connected",
} as FleetInstance
const node = {
  id: "node-a",
  name: "Relay node",
  relayId: "1".repeat(12),
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
    instances: getRelayServersCollection(clients.dbClient),
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
    id: "1".repeat(12),
    name: "Relay A",
    status: "connected",
    updating: false,
  } as const

  function foundPage(instance: FleetInstance): ServerWorkspace {
    return {
      relay: relayAState,
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

  it("reads a missing server again when it appears during the read", async () => {
    const clients = fleet()
    const reads = stagedPageReads()
    const navigation = ensureServerWorkspace(clients.queryClient, alpha.id)
    await vi.waitFor(() => expect(reads).toHaveLength(1))

    applyEvent(clients, instancesDelta([alpha]))
    reads[0]!.answer({ status: "not-found" })
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[1]!.answer(foundPage(alpha))

    await expect(navigation).resolves.toMatchObject({ status: "found" })
  })
})
