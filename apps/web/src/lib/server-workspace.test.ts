import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

// Hearth's server functions are the network boundary; these cases read only
// what the page already holds.
vi.mock("@/server/relay", () => ({ getServerWorkspace: vi.fn() }))

import { queryKeys } from "@/lib/query-options"
import { knownServer } from "@/lib/server-workspace"

const relayId = "r".repeat(43)
const alpha = {
  brickId: "paper",
  connectAddress: "play.example.test",
  game: "Minecraft",
  id: `aaaaaaaa${"1".repeat(32)}`,
  implementation: "Paper",
  name: "Alpha",
  relayId,
  relayName: "Relay A",
  routeId: `${relayId}-aaaaaaaa`,
  shortId: "aaaaaaaa",
  version: "1.21.11",
}
const twin = {
  ...alpha,
  id: `aaaaaaaa${"2".repeat(32)}`,
  name: "Twin",
  relayId: "s".repeat(43),
  routeId: `${"s".repeat(43)}-aaaaaaaa`,
}

function client(seed: (queryClient: QueryClient) => void) {
  const queryClient = new QueryClient()
  seed(queryClient)
  return queryClient
}

describe("opening a game server the page already knows", () => {
  it("knows a server the directory names exactly once", () => {
    const queryClient = client((queryClient) =>
      queryClient.setQueryData(queryKeys.servers.directory, [alpha])
    )

    expect(knownServer(queryClient, alpha.shortId)).toEqual({
      routeIdentifier: alpha.shortId,
      server: alpha,
    })
    expect(knownServer(queryClient, alpha.name)?.server.id).toBe(alpha.id)
    expect(knownServer(queryClient, "deadbeef")).toBeUndefined()
  })

  it("does not guess between servers sharing a short ID", () => {
    const queryClient = client((queryClient) =>
      queryClient.setQueryData(queryKeys.servers.directory, [alpha, twin])
    )

    expect(knownServer(queryClient, alpha.shortId)).toBeUndefined()
    // A Relay-qualified ID still names one, and is its canonical route.
    expect(knownServer(queryClient, alpha.routeId)).toEqual({
      routeIdentifier: alpha.routeId,
      server: alpha,
    })
  })

  it("knows the sidebar's server by its IDs when no directory is loaded", () => {
    const queryClient = client((queryClient) => {
      queryClient.setQueryData(
        [...queryKeys.servers.navigation, null, alpha.shortId],
        {
          ambiguous: false,
          instance: alpha,
          routeId: alpha.shortId,
          serverCount: 2,
        }
      )
      queryClient.setQueryData(
        [...queryKeys.servers.navigation, "bbbbbbbb", null],
        { ambiguous: true, instance: null, routeId: null, serverCount: 2 }
      )
    })

    expect(knownServer(queryClient, alpha.shortId)).toEqual({
      routeIdentifier: alpha.shortId,
      server: alpha,
    })
    // A navigation entry was resolved for another identifier; a name could
    // mean another server.
    expect(knownServer(queryClient, alpha.name)).toBeUndefined()
    expect(knownServer(queryClient, "bbbbbbbb")).toBeUndefined()
  })
})
