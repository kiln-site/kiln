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
// What Hearth answers the Updates dialog with; tests decide.
const updatesServer = vi.hoisted(() => ({
  getLatestKilnReleases: vi.fn(),
  getRelayRelease: vi.fn(),
  getReleaseHistory: vi.fn(),
  getUpdateEligibility: vi.fn(),
  getUpdateOverview: vi.fn(),
}))
vi.mock("@/server/updates", () => updatesServer)

import { QueryObserver } from "@tanstack/react-query"

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { createAppClients, type AppRouterContext } from "@/lib/query-client"
import type {
  FleetInstance,
  FleetNode,
  RealtimeClientEvent,
} from "@/lib/realtime-events"
import { applyRealtimeEventSafely } from "@/lib/realtime-client"
import {
  updateEligibilityQueryOptions,
  updateOverviewQueryOptions,
} from "@/lib/query-options"
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

describe("Updates dialog", () => {
  const relayId = "1".repeat(12)
  const eligibility = (answer: { eligible: boolean; reachable: boolean }) => ({
    hearth: null,
    hearthPending: false,
    relays: [
      {
        ...answer,
        pending: false,
        reason: answer.reachable ? null : "The Relay didn't answer in time",
        relayId,
      },
    ],
  })

  // A Relay still connecting when the dialog opened is listed as reachable,
  // and its inspection timed out; once it connects it's asked again.
  it("asks a Relay that has connected whether it can update", async () => {
    const clients = fleet()
    updatesServer.getUpdateOverview.mockResolvedValue({
      canUpdateHearth: false,
      currentVersion: "0.1.0",
      previousVersions: {},
      relays: [
        {
          currentVersion: "0.1.0",
          name: "Relay A",
          ownedByViewer: true,
          ownerName: null,
          reachable: true,
          reason: null,
          relayId,
        },
      ],
      relaysWaitForHearth: false,
      releases: [],
      releasesCheckedAt: null,
    })
    updatesServer.getUpdateEligibility
      .mockResolvedValueOnce(eligibility({ eligible: false, reachable: false }))
      .mockResolvedValue(eligibility({ eligible: true, reachable: true }))
    await clients.queryClient.fetchQuery(updateOverviewQueryOptions())
    const observer = new QueryObserver(
      clients.queryClient,
      updateEligibilityQueryOptions()
    )
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.relays[0]).toMatchObject({
        reachable: false,
      })
    )

    applyEvent(clients, {
      epoch,
      relayId,
      sequence: 2,
      status: "connected",
      type: "relay.status",
      updating: false,
    })

    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.relays[0]).toMatchObject({
        eligible: true,
        reachable: true,
      })
    )
    unsubscribe()
  })
})
