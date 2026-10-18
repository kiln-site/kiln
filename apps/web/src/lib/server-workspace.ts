import {
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"

import { ensuringPromise } from "@/effect/promise"
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

type RelayState = Pick<ServerWorkspaceRelay, "id" | "status" | "updating">

// Changes pushed while reads are in flight. Each read replays the ones that
// arrived after it started onto its answer, so an answer from before a change
// cannot overwrite it. A gap in pushed changes cannot be replayed; a read that
// spans one reads again.
type PushedChange =
  | { sequence: number; type: "gap" }
  | {
      apply: (workspace: FoundServerWorkspace) => ServerWorkspace
      sequence: number
      type: "change"
    }

const maximumMissingRereads = 3
let pushedSequence = 0
let readsInFlight = 0
let pushedDuringReads: Array<PushedChange> = []

function recordPushedChange(
  change:
    | { type: "gap" }
    | Omit<Extract<PushedChange, { type: "change" }>, "sequence">
) {
  pushedSequence += 1
  if (readsInFlight > 0)
    pushedDuringReads.push({ ...change, sequence: pushedSequence })
}

export function serverWorkspaceQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: queryKeys.relay.server(serverId),
    queryFn: ({ signal }) => {
      readsInFlight += 1
      return ensuringPromise(
        () => readServerWorkspace(serverId, signal),
        () => {
          readsInFlight -= 1
          if (readsInFlight === 0) pushedDuringReads = []
        }
      )
    },
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  })
}

async function readServerWorkspace(
  serverId: string,
  signal: AbortSignal
): Promise<ServerWorkspace> {
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = pushedSequence
    const read = await getServerWorkspace({ data: { serverId }, signal })
    const missed = pushedDuringReads.filter(
      ({ sequence }) => sequence > startedAt
    )
    // A server created while this read was in flight may be missing from
    // it; pushes are frequent, so only a few rereads.
    if (
      missed.some(({ type }) => type === "gap") ||
      (read.status !== "found" &&
        missed.length > 0 &&
        attempt < maximumMissingRereads)
    ) {
      continue
    }
    let workspace: ServerWorkspace =
      read.status === "found"
        ? { ...read, snapshot: reconcilePendingPowerSnapshot(read.snapshot) }
        : read
    for (const change of missed) {
      if (workspace.status === "found" && change.type === "change")
        workspace = change.apply(workspace)
    }
    return workspace
  }
}

/**
 * The server a navigation to `serverId` opens. A cached answer is kept current
 * by pushed changes, so it is reused when `serverId` names that server by an
 * ID and nothing has marked it stale. A name may now mean another server, and
 * an answer that was missing or ambiguous may have changed, so those are read
 * again.
 */
export async function ensureServerWorkspace(
  queryClient: QueryClient,
  serverId: string
): Promise<ServerWorkspace> {
  const options = serverWorkspaceQueryOptions(serverId)
  const cached = queryClient.getQueryData(options.queryKey)
  const [instance] = cached?.status === "found" ? cached.snapshot.instances : []
  const reusable =
    instance !== undefined &&
    !queryClient.getQueryState(options.queryKey)?.isInvalidated &&
    (serverId === instance.shortId ||
      serverId === instance.routeId ||
      serverId === instance.id)
  return reusable && cached
    ? cached
    : queryClient.fetchQuery({ ...options, staleTime: 0 })
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
 * Applies a pushed change to the game server pages it touches, and to reads
 * in flight when they land. A server that now shares a page's short ID makes
 * that ID ambiguous, so the page resolves again.
 */
export function applyPushedServerWorkspaceChange(
  queryClient: QueryClient,
  update: SnapshotUpdate,
  options: {
    relay?: RelayState
    upserted?: ReadonlyArray<RelayFleetSnapshot["instances"][number]>
  } = {}
): void {
  const { relay, upserted = [] } = options
  const apply = (workspace: FoundServerWorkspace): ServerWorkspace => {
    const scoped = scopeServerWorkspace(workspace, update(workspace.snapshot))
    return relay && scoped.status === "found"
      ? withRelayStatus(scoped, relay)
      : scoped
  }
  recordPushedChange({ apply, type: "change" })
  const collided: Array<QueryKey> = []
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.relay.servers })) {
    const workspace = query.state.data as ServerWorkspace | undefined
    if (workspace?.status !== "found") continue
    const [current] = workspace.snapshot.instances
    if (
      current &&
      upserted.some(
        (instance) =>
          instance.shortId === current.shortId &&
          (instance.id !== current.id || instance.relayId !== current.relayId)
      )
    ) {
      collided.push(query.queryKey)
    }
    queryClient.setQueryData<ServerWorkspace>(query.queryKey, apply(workspace))
  }
  for (const queryKey of collided)
    void queryClient.invalidateQueries(
      { exact: true, queryKey },
      { cancelRefetch: false }
    )
}

/**
 * Rereads every game server page after a gap in pushed changes, and marks the
 * rest stale so a navigation resolves them again. Fails when a reread fails,
 * so stream recovery retries.
 */
export async function recheckServerWorkspaces(
  queryClient: QueryClient
): Promise<void> {
  recordPushedChange({ type: "gap" })
  // A read in flight reads again by itself; cancelling it would fail the
  // navigation waiting on it.
  await queryClient.invalidateQueries(
    { queryKey: queryKeys.relay.servers },
    { cancelRefetch: false, throwOnError: true }
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
  relay: RelayState
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
