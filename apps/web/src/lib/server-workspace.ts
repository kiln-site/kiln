import { queryOptions, type QueryClient } from "@tanstack/react-query"

import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import { queryKeys } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { getServerWorkspace } from "@/server/relay"

/**
 * A game server page's own data: its server and node in the fleet snapshot's
 * shape, so fleet selectors and updates apply to it unchanged, and its
 * Relay's connection. Pushed changes keep it current, as they do the fleet.
 */
export type ServerWorkspace = Awaited<ReturnType<typeof getServerWorkspace>>
export type FoundServerWorkspace = Extract<ServerWorkspace, { status: "found" }>
export type ServerWorkspaceRelay = FoundServerWorkspace["relay"]

type SnapshotUpdate = (
  snapshot: RelayFleetSnapshot | undefined
) => RelayFleetSnapshot | undefined

// Changes pushed or missed since this session started. A read that spans
// one may answer from before it, so it reads again.
let pushedChanges = 0
const maximumReadAttempts = 3

export function serverWorkspaceQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: queryKeys.relay.server(serverId),
    queryFn: async ({ signal }): Promise<ServerWorkspace> => {
      let workspace: ServerWorkspace
      let attempt = 0
      let seen: number
      do {
        seen = pushedChanges
        attempt += 1
        workspace = await getServerWorkspace({ data: { serverId }, signal })
      } while (seen !== pushedChanges && attempt < maximumReadAttempts)
      return workspace.status === "found"
        ? {
            ...workspace,
            snapshot: reconcilePendingPowerSnapshot(workspace.snapshot),
          }
        : workspace
    },
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  })
}

/** Applies a fleet snapshot update to the fleet and every game server page. */
export function updateRelaySnapshots(
  queryClient: QueryClient,
  update: SnapshotUpdate
): void {
  queryClient.setQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot, update)
  updateServerWorkspaces(queryClient, update)
}

/** Applies a fleet snapshot update to every game server page it touches. */
export function updateServerWorkspaces(
  queryClient: QueryClient,
  update: SnapshotUpdate
): void {
  queryClient.setQueriesData<ServerWorkspace>(
    { queryKey: queryKeys.relay.servers },
    (workspace) =>
      workspace?.status === "found"
        ? scopeServerWorkspace(workspace, update(workspace.snapshot))
        : workspace
  )
}

/**
 * Applies a pushed change to the game server pages it touches. A read in
 * flight reads again rather than land behind it.
 */
export function applyPushedServerWorkspaceChange(
  queryClient: QueryClient,
  update: SnapshotUpdate,
  options: {
    relay?: Pick<ServerWorkspaceRelay, "id" | "status" | "updating">
    // Node readings change often and a later one corrects a missed one.
    changesServers?: boolean
  } = {}
): void {
  const { changesServers = true, relay } = options
  if (changesServers) pushedChanges += 1
  queryClient.setQueriesData<ServerWorkspace>(
    { queryKey: queryKeys.relay.servers },
    (workspace) => {
      if (workspace?.status !== "found") return workspace
      const scoped = scopeServerWorkspace(workspace, update(workspace.snapshot))
      return relay && scoped.status === "found"
        ? withRelayStatus(scoped, relay)
        : scoped
    }
  )
}

/** Rereads every game server page, as after a gap in pushed changes. */
export function recheckServerWorkspaces(queryClient: QueryClient): void {
  pushedChanges += 1
  // A read in flight reads again by itself; cancelling it would fail the
  // navigation waiting on it.
  void queryClient.invalidateQueries(
    { queryKey: queryKeys.relay.servers },
    { cancelRefetch: false }
  )
}

// An update written for the fleet may add or remove other servers; a page
// keeps its own server and that server's node, or learns it is gone.
function scopeServerWorkspace(
  workspace: FoundServerWorkspace,
  snapshot: RelayFleetSnapshot | undefined
): ServerWorkspace {
  if (!snapshot || snapshot === workspace.snapshot) return workspace
  const [current] = workspace.snapshot.instances
  const instance = current
    ? snapshot.instances.find(
        (candidate) =>
          candidate.id === current.id && candidate.relayId === current.relayId
      )
    : undefined
  if (!instance) return { status: "not-found" }
  const nodes = snapshot.nodes.filter(
    (node) => node.relayId === instance.relayId
  )
  return instance === current &&
    nodes.length === workspace.snapshot.nodes.length &&
    nodes.every((node, index) => node === workspace.snapshot.nodes[index])
    ? workspace
    : { ...workspace, snapshot: { instances: [instance], nodes } }
}

function withRelayStatus(
  workspace: FoundServerWorkspace,
  relay: Pick<ServerWorkspaceRelay, "id" | "status" | "updating">
): FoundServerWorkspace {
  if (
    workspace.relay.id !== relay.id ||
    (workspace.relay.status === relay.status &&
      workspace.relay.updating === relay.updating)
  ) {
    return workspace
  }
  return {
    ...workspace,
    relay: {
      ...workspace.relay,
      status: relay.status,
      updating: relay.updating,
    },
  }
}

/** A game server as this session last saw it, in the fleet or on its page. */
export function cachedRelayInstance(
  queryClient: QueryClient,
  relayId: string,
  instanceId: string
): RelayFleetSnapshot["instances"][number] | undefined {
  const matches = (instance: RelayFleetSnapshot["instances"][number]) =>
    instance.id === instanceId && instance.relayId === relayId
  const fleet = queryClient
    .getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
    ?.instances.find(matches)
  if (fleet) return fleet
  for (const [, workspace] of queryClient.getQueriesData<ServerWorkspace>({
    queryKey: queryKeys.relay.servers,
  })) {
    const instance =
      workspace?.status === "found"
        ? workspace.snapshot.instances.find(matches)
        : undefined
    if (instance) return instance
  }
  return undefined
}

/** Rereads the fleet and every game server page after a change to a server. */
export function invalidateRelaySnapshots(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
    queryClient.invalidateQueries({ queryKey: queryKeys.relay.servers }),
  ])
}
