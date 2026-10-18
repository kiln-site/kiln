import {
  queryOptions,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"

import { reconcilePendingPowerSnapshot } from "@/lib/instance-power-state"
import { queryKeys } from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { resolveRelayInstance } from "@/lib/relay-selectors"
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
type ServerInstance = RelayFleetSnapshot["instances"][number]

// What a change does to the set of servers a route can name.
interface ServerChanges {
  removesServers?: boolean
  upserted?: ReadonlyArray<ServerInstance>
}

/*
 * Pushed changes, mutation responses, and gaps in pushed changes, numbered in
 * the order they reached this page. A read answers from the moment Hearth
 * served it, so when its answer is stored every change numbered after the
 * read began is applied to it again, in order. Each change writes a whole
 * server, a deletion, or a Relay status, so applying one twice is harmless.
 *
 * A gap cannot be replayed, and neither can a change that makes a page's
 * route mean something else, such as another server taking its short ID.
 * Those mark the page as needing resolution. Only a read that began after the
 * mark clears it, and a page still marked after its read is read again.
 */
type Change =
  | { sequence: number; type: "gap" }
  | {
      apply: (workspace: FoundServerWorkspace) => ServerWorkspace
      removesServers: boolean
      sequence: number
      type: "change"
      upserted: ReadonlyArray<ServerInstance>
    }

// Reads in a row a navigation or recovery waits for while changes keep
// landing during them.
const maximumReads = 10

interface ReadState {
  changes: Array<Change>
  // When each page's read in flight began, by query hash.
  readsStartedAt: Map<string, number>
  sequence: number
  // Pages whose route must resolve again, and when they were marked.
  unresolvedSince: Map<string, number>
}

const readStates = new WeakMap<QueryClient, ReadState>()

function readState(queryClient: QueryClient): ReadState {
  let state = readStates.get(queryClient)
  if (!state) {
    state = {
      changes: [],
      readsStartedAt: new Map(),
      sequence: 0,
      unresolvedSince: new Map(),
    }
    readStates.set(queryClient, state)
    watchStoredReads(queryClient, state)
  }
  return state
}

export function serverWorkspaceQueryOptions(serverId: string) {
  return queryOptions({
    queryKey: queryKeys.relay.server(serverId),
    queryFn: async ({ client, queryKey, signal }) => {
      const state = readState(client)
      const queryHash = client
        .getQueryCache()
        .find({ exact: true, queryKey })?.queryHash
      if (queryHash) state.readsStartedAt.set(queryHash, state.sequence)
      const read = await getServerWorkspace({ data: { serverId }, signal })
      return read.status === "found"
        ? { ...read, snapshot: reconcilePendingPowerSnapshot(read.snapshot) }
        : read
    },
    refetchOnWindowFocus: false,
    staleTime: 5_000,
  })
}

/**
 * The server a navigation to `serverId` opens. A cached answer is kept current
 * by pushed changes, so it is reused when `serverId` names that server by an
 * ID and nothing has marked its route for resolution. A name may now mean
 * another server, and an answer that was missing or ambiguous may have
 * changed, so those are read again.
 */
export async function ensureServerWorkspace(
  queryClient: QueryClient,
  serverId: string
): Promise<ServerWorkspace> {
  const options = serverWorkspaceQueryOptions(serverId)
  const query = queryClient
    .getQueryCache()
    .find<ServerWorkspace>({ exact: true, queryKey: options.queryKey })
  const cached = query?.state.data
  const [instance] = cached?.status === "found" ? cached.snapshot.instances : []
  const reusable =
    query !== undefined &&
    instance !== undefined &&
    !readState(queryClient).unresolvedSince.has(query.queryHash) &&
    (serverId === instance.shortId ||
      serverId === instance.routeId ||
      serverId === instance.id)
  if (reusable && cached) return cached
  // A change during the read may leave its route needing resolution again.
  for (let attempt = 1; ; attempt += 1) {
    const read = await queryClient.fetchQuery({ ...options, staleTime: 0 })
    if (!unresolved(queryClient, options.queryKey))
      // What was stored, with any changes pushed during the read replayed.
      return queryClient.getQueryData(options.queryKey) ?? read
    if (attempt >= maximumReads)
      throw new Error("This game server kept changing while it was opened")
  }
}

/** Applies a fleet snapshot update to the fleet and every game server page. */
export function updateRelaySnapshots(
  queryClient: QueryClient,
  update: SnapshotUpdate,
  changes: ServerChanges = {}
): void {
  queryClient.setQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot, update)
  updateServerWorkspaces(queryClient, update, changes)
}

/** Applies a fleet snapshot update to every game server page it touches. */
export function updateServerWorkspaces(
  queryClient: QueryClient,
  update: SnapshotUpdate,
  changes: ServerChanges = {}
): void {
  applyChange(
    queryClient,
    (workspace) => scopeServerWorkspace(workspace, update(workspace.snapshot)),
    changes
  )
}

/** Applies a pushed change to the game server pages it touches. */
export function applyPushedServerWorkspaceChange(
  queryClient: QueryClient,
  update: SnapshotUpdate,
  options: ServerChanges & { relay?: RelayState } = {}
): void {
  const { relay, ...changes } = options
  applyChange(
    queryClient,
    (workspace) => {
      const scoped = scopeServerWorkspace(workspace, update(workspace.snapshot))
      return relay && scoped.status === "found"
        ? withRelayStatus(scoped, relay)
        : scoped
    },
    changes
  )
}

/**
 * Rereads every game server page shown after a gap in pushed changes, and
 * marks every page for resolution so a navigation reads it again. Fails when
 * a reread fails, so stream recovery retries.
 */
export async function recheckServerWorkspaces(
  queryClient: QueryClient
): Promise<void> {
  const state = readState(queryClient)
  state.sequence += 1
  if (state.readsStartedAt.size > 0)
    state.changes.push({ sequence: state.sequence, type: "gap" })
  for (const query of serverWorkspaceQueries(queryClient))
    state.unresolvedSince.set(query.queryHash, state.sequence)
  // Reread every shown page until none needs resolution. A read in flight is
  // joined rather than cancelled, which would fail the navigation waiting on
  // it; it reads again once stored if it began before the gap.
  for (let attempt = 1; ; attempt += 1) {
    const pending = serverWorkspaceQueries(queryClient).filter(
      (query) => query.isActive() && state.unresolvedSince.has(query.queryHash)
    )
    if (pending.length === 0) return
    if (attempt > maximumReads)
      throw new Error("Game server pages kept changing during their reads")
    await Promise.all(
      pending.map((query) =>
        queryClient.refetchQueries(
          { exact: true, queryKey: query.queryKey },
          { cancelRefetch: false, throwOnError: true }
        )
      )
    )
  }
}

function applyChange(
  queryClient: QueryClient,
  apply: (workspace: FoundServerWorkspace) => ServerWorkspace,
  { removesServers = false, upserted = [] }: ServerChanges
) {
  const state = readState(queryClient)
  state.sequence += 1
  if (state.readsStartedAt.size > 0)
    state.changes.push({
      apply,
      removesServers,
      sequence: state.sequence,
      type: "change",
      upserted,
    })
  for (const query of serverWorkspaceQueries(queryClient)) {
    const workspace = query.state.data
    if (workspace?.status !== "found") continue
    if (takesShortId(workspace, upserted)) {
      state.unresolvedSince.set(query.queryHash, state.sequence)
      // A read in flight answers for the old meaning; it reads again once
      // stored.
      void queryClient.invalidateQueries(
        { exact: true, queryKey: query.queryKey },
        { cancelRefetch: false }
      )
    }
    const next = apply(workspace)
    if (next !== workspace) queryClient.setQueryData(query.queryKey, next)
  }
}

// Replays what a stored read missed, and resolves it again if its route may
// now mean something else.
function watchStoredReads(queryClient: QueryClient, state: ReadState) {
  queryClient.getQueryCache().subscribe((event) => {
    const { query } = event
    if (event.type === "removed") {
      state.readsStartedAt.delete(query.queryHash)
      state.unresolvedSince.delete(query.queryHash)
      pruneChanges(state)
      return
    }
    if (event.type !== "updated") return
    const startedAt = state.readsStartedAt.get(query.queryHash)
    if (startedAt === undefined) return
    const { action } = event
    if (action.type !== "success" || action.manual) {
      // A read that failed or was cancelled stores nothing to replay onto.
      if (query.state.fetchStatus === "idle") {
        state.readsStartedAt.delete(query.queryHash)
        pruneChanges(state)
      }
      return
    }
    state.readsStartedAt.delete(query.queryHash)
    const serverId = String(query.queryKey[2])
    let workspace = query.state.data as ServerWorkspace | undefined
    for (const change of changesSince(state, startedAt)) {
      if (!workspace) break
      if (changesResolution(serverId, workspace, change))
        state.unresolvedSince.set(query.queryHash, change.sequence)
      if (change.type === "change" && workspace.status === "found") {
        workspace = change.apply(workspace)
        if (renamedAway(serverId, workspace))
          state.unresolvedSince.set(query.queryHash, change.sequence)
      }
    }
    if (workspace !== query.state.data)
      queryClient.setQueryData(query.queryKey, workspace)
    const markedAt = state.unresolvedSince.get(query.queryHash)
    if (markedAt !== undefined && markedAt <= startedAt)
      state.unresolvedSince.delete(query.queryHash)
    pruneChanges(state)
    if (state.unresolvedSince.has(query.queryHash))
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: query.queryKey,
      })
  })
}

// Whether a change a stored answer missed may change what its route names.
// After a gap, anything may have. A server found by an ID is ambiguous once
// another takes its short ID; one found by name, once another takes the name
// or it is renamed away (checked after the change applies). A missing answer
// changes when a server its identifier names appears. An ambiguous answer is
// rare and changes with any server's arrival, rename, or removal.
function changesResolution(
  serverId: string,
  workspace: ServerWorkspace,
  change: Change
): boolean {
  if (change.type === "gap") return true
  if (workspace.status === "ambiguous")
    return change.removesServers || change.upserted.length > 0
  if (workspace.status === "not-found")
    return (
      resolveRelayInstance([...change.upserted], serverId).status !==
      "not-found"
    )
  return (
    takesShortId(workspace, change.upserted) ||
    (foundByName(serverId, workspace) &&
      change.upserted.some(
        (instance) =>
          instance.name === serverId &&
          !sameServer(instance, workspace.snapshot.instances[0])
      ))
  )
}

// A server found by name that no longer has that name.
function renamedAway(serverId: string, workspace: ServerWorkspace) {
  return (
    workspace.status === "found" &&
    foundByName(serverId, workspace) &&
    workspace.snapshot.instances[0]?.name !== serverId
  )
}

function foundByName(serverId: string, workspace: FoundServerWorkspace) {
  const [instance] = workspace.snapshot.instances
  return (
    instance !== undefined &&
    serverId !== instance.shortId &&
    serverId !== instance.routeId &&
    serverId !== instance.id
  )
}

function sameServer(
  instance: ServerInstance,
  other: ServerInstance | undefined
) {
  return instance.id === other?.id && instance.relayId === other.relayId
}

function unresolved(queryClient: QueryClient, queryKey: QueryKey) {
  const query = queryClient.getQueryCache().find({ exact: true, queryKey })
  return (
    query !== undefined &&
    readState(queryClient).unresolvedSince.has(query.queryHash)
  )
}

// Another server taking a page's short ID makes that ID ambiguous.
function takesShortId(
  workspace: FoundServerWorkspace,
  upserted: ReadonlyArray<ServerInstance>
) {
  const [current] = workspace.snapshot.instances
  return (
    current !== undefined &&
    upserted.some(
      (instance) =>
        instance.shortId === current.shortId && !sameServer(instance, current)
    )
  )
}

function changesSince(state: ReadState, startedAt: number) {
  return state.changes.filter((change) => change.sequence > startedAt)
}

function pruneChanges(state: ReadState) {
  const oldest = Math.min(...state.readsStartedAt.values())
  state.changes = state.changes.filter((change) => change.sequence > oldest)
}

function serverWorkspaceQueries(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.relay.servers })
    .map((query) => query as Query<ServerWorkspace>)
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
