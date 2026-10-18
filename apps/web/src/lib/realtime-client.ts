import type { QueryClient } from "@tanstack/react-query"
import { Result } from "effect"
import type { RelayInstance } from "@workspace/contracts"

import type { RelayInstancesCollection } from "@/lib/collections/relay-instances"
import {
  invalidateNameDependentBackupRuns,
  refreshHearthRealtimeTopics,
} from "@/lib/hearth-realtime"
import type {
  HearthRealtimeScope,
  hearthRealtimeTopics,
} from "@/lib/hearth-realtime-topics"
import {
  queryKeys,
  replaceRelaySnapshotInstance,
  type RelayConnection,
  type RelayReachability,
} from "@/lib/query-options"
import type { FleetInstance, RealtimeClientEvent } from "@/lib/realtime-events"
import {
  instanceInventoryScope,
  recheckInstanceObservations,
} from "@/lib/instance-inventory"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  recordReachabilityGap,
  recordReachabilityPush,
} from "@/lib/relay-reachability"
import {
  applyPushedServerWorkspaceChange,
  updateRelaySnapshots,
  updateServerWorkspaces,
} from "@/lib/server-workspace"

export interface ApplyRealtimeEventInput {
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
  instances: RelayInstancesCollection
  queryClient: QueryClient
  refreshTopics?: (
    topics: ReadonlyArray<(typeof hearthRealtimeTopics)[number]>,
    scope?: HearthRealtimeScope
  ) => Promise<void>
}

function applyRealtimeEvent(input: ApplyRealtimeEventInput): void {
  const { event, instances, queryClient, refreshTopics } = input
  if (event.type === "collections.invalidate") {
    void (
      refreshTopics?.(event.topics, event.scope) ??
      refreshHearthRealtimeTopics(queryClient, event.topics, event.scope)
    )
    return
  }
  const instanceIdentityChanged =
    event.type === "instances.delta" &&
    realtimeInstanceIdentityChanged(queryClient, event)
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) => applyRealtimeSnapshotEvent(snapshot, event)
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) => {
      if (event.type === "relay.status") {
        return applyRealtimeRelayStatus(
          connection,
          queryClient.getQueryData<RelayFleetSnapshot>(
            queryKeys.relay.snapshot
          ),
          event
        )
      }
      return hasRelaySnapshot(connection)
        ? {
            ...connection,
            snapshot:
              applyRealtimeSnapshotEvent(connection.snapshot, event) ??
              connection.snapshot,
          }
        : connection
    }
  )
  applyPushedServerWorkspaceChange(
    queryClient,
    (snapshot) => applyRealtimeSnapshotEvent(snapshot, event),
    {
      removesServers:
        event.type === "instances.delta" && event.deleted.length > 0,
      upserted: event.type === "instances.delta" ? event.upserted : undefined,
      relay:
        event.type === "relay.status"
          ? {
              id: event.relayId,
              status: event.status,
              updating: event.updating ?? false,
            }
          : undefined,
    }
  )
  if (event.type === "instances.delta") {
    // Game servers push their state; refresh only the ones that changed.
    for (const { relayId, id } of [
      ...event.upserted,
      ...event.deleted.map(({ relayId, instanceId }) => ({
        relayId,
        id: instanceId,
      })),
    ])
      void recheckInstanceObservations(queryClient, {
        queryKey: instanceInventoryScope({ kind: "server", relayId, id }),
      })
    if (!instances.isReady()) {
      const snapshot = queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
      // With no fleet loaded there is nothing to patch; its first reader
      // fetches it fresh.
      queryClient.setQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances,
        (current) => {
          const rows = current ?? snapshot?.instances
          return rows && applyRealtimeInstancesEvent(rows, event)
        }
      )
      if (instanceIdentityChanged) {
        void invalidateNameDependentBackupRuns(queryClient)
      }
      return
    }
    instances.utils.writeBatch(() => {
      for (const item of event.upserted) {
        const key = `${item.relayId}:${item.id}`
        instances.utils.writeUpsert(
          mergeRealtimeInstance(
            instances.get(key) as FleetInstance | undefined,
            item
          )
        )
      }
      const deletedKeys = [
        ...new Set(
          event.deleted.map(
            ({ instanceId, relayId }) => `${relayId}:${instanceId}`
          )
        ),
      ].filter((key) => instances.has(key))
      if (deletedKeys.length > 0) instances.utils.writeDelete(deletedKeys)
    })
    if (instanceIdentityChanged) {
      void invalidateNameDependentBackupRuns(queryClient)
    }
    return
  }
  if (event.type === "relay.status") {
    queryClient.setQueryData<RelayReachability>(
      queryKeys.relay.reachability,
      (relays) =>
        relays?.map((relay) =>
          relay.id === event.relayId && relay.status !== event.status
            ? { ...relay, status: event.status }
            : relay
        )
    )
    recordReachabilityPush(queryClient, event.relayId, event.status)
    // Every observation on this Relay depends on its reachability.
    void recheckInstanceObservations(queryClient, {
      predicate: ({ queryKey }) =>
        queryKey[0] === "instance-inventory" && queryKey[2] === event.relayId,
    })
    if (!instances.isReady()) {
      const snapshot = queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
      queryClient.setQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances,
        snapshot?.instances
      )
      return
    }
    const changed = instances.toArray.flatMap((instance) =>
      relayStatusChanged(instance, event)
        ? [withRelayStatus(instance, event)]
        : []
    )
    // Query Collection manual writes commit the collection and its backing
    // TanStack Query cache together. A second setQueryData here would notify
    // subscribers twice for the same reachability transition.
    if (changed.length > 0) instances.utils.writeUpsert(changed)
  }
}

export function applyRealtimeEventSafely(
  input: ApplyRealtimeEventInput,
  onFailure: (cause: unknown) => void
): boolean {
  return Result.match(
    Result.try(() => applyRealtimeEvent(input)),
    {
      onFailure: (cause) => {
        onFailure(cause)
        return false
      },
      onSuccess: () => true,
    }
  )
}

function applyRealtimeSnapshotEvent(
  snapshot: RelayFleetSnapshot | undefined,
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
): RelayFleetSnapshot | undefined {
  if (!snapshot) return snapshot
  if (event.type === "collections.invalidate") return snapshot
  if (event.type === "nodes.delta") {
    const nodes = new Map(event.nodes.map((node) => [node.relayId, node]))
    const nextNodes = snapshot.nodes.map((node) => {
      const updated = nodes.get(node.relayId)
      if (updated) nodes.delete(node.relayId)
      return updated ?? node
    })
    return { ...snapshot, nodes: [...nextNodes, ...nodes.values()] }
  }
  if (event.type === "relay.status") {
    return {
      ...snapshot,
      instances: snapshot.instances.map((instance) =>
        relayStatusChanged(instance, event)
          ? withRelayStatus(instance, event)
          : instance
      ),
      nodes: snapshot.nodes.map((node) =>
        relayStatusChanged(node, event) ? withRelayStatus(node, event) : node
      ),
    }
  }
  return {
    ...snapshot,
    instances: applyRealtimeInstancesEvent(snapshot.instances, event),
  }
}

type RelayStatusEvent = Extract<RealtimeClientEvent, { type: "relay.status" }>

function relayStatusChanged(
  item: { relayId: string; relayStatus: string; relayUpdating?: boolean },
  event: RelayStatusEvent
): boolean {
  return (
    item.relayId === event.relayId &&
    (item.relayStatus !== event.status ||
      (item.relayUpdating ?? false) !== (event.updating ?? false))
  )
}

function withRelayStatus<T extends { relayUpdating?: boolean }>(
  item: T,
  event: RelayStatusEvent
): T & { relayStatus: RelayStatusEvent["status"] } {
  return {
    ...item,
    relayStatus: event.status,
    relayUpdating: event.updating ?? false,
  }
}

function applyRealtimeInstancesEvent(
  instances: ReadonlyArray<FleetInstance>,
  event: Extract<RealtimeClientEvent, { type: "instances.delta" }>
): Array<FleetInstance> {
  const deleted = new Set(
    event.deleted.map(({ instanceId, relayId }) => `${relayId}:${instanceId}`)
  )
  const upserted = new Map(
    event.upserted.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      instance,
    ])
  )
  const nextInstances = instances.flatMap((instance) => {
    const key = `${instance.relayId}:${instance.id}`
    if (deleted.has(key)) return []
    const updated = upserted.get(key)
    if (updated) upserted.delete(key)
    return [updated ? mergeRealtimeInstance(instance, updated) : instance]
  })
  return [...upserted.values(), ...nextInstances]
}

export function applyProvisioningInstance(
  queryClient: QueryClient,
  updated: FleetInstance
): void {
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) => upsertRelaySnapshotInstance(snapshot, updated)
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      hasRelaySnapshot(connection)
        ? {
            ...connection,
            snapshot:
              upsertRelaySnapshotInstance(connection.snapshot, updated) ??
              connection.snapshot,
          }
        : connection
  )
  updateServerWorkspaces(
    queryClient,
    (snapshot) => upsertRelaySnapshotInstance(snapshot, updated),
    { upserted: [updated] }
  )
  queryClient.setQueryData<Array<FleetInstance>>(
    queryKeys.relay.instances,
    (instances) => {
      if (!instances) return instances
      const index = instances.findIndex(
        (instance) =>
          instance.id === updated.id && instance.relayId === updated.relayId
      )
      if (index === -1) return [updated, ...instances]
      return instances.map((instance, currentIndex) =>
        currentIndex === index
          ? mergeRealtimeInstance(instance, updated)
          : instance
      )
    }
  )
}

export function applyUpdatedInstance(
  queryClient: QueryClient,
  updated: RelayInstance & { relayId: string }
): void {
  const current = queryClient
    .getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
    ?.instances.find(
      (instance) =>
        instance.id === updated.id && instance.relayId === updated.relayId
    )
  updateRelaySnapshots(
    queryClient,
    (snapshot) => replaceRelaySnapshotInstance(snapshot, updated),
    { upserted: [{ ...current, ...updated } as FleetInstance] }
  )
  queryClient.setQueryData<Array<FleetInstance>>(
    queryKeys.relay.instances,
    (instances) =>
      instances?.map((instance) =>
        instance.id === updated.id && instance.relayId === updated.relayId
          ? mergeRealtimeInstance(instance, { ...instance, ...updated })
          : instance
      )
  )
  if (!current || current.name !== updated.name) {
    void invalidateNameDependentBackupRuns(queryClient)
  }
}

export function applyDeletedInstance(
  queryClient: QueryClient,
  deleted: { instanceId: string; relayId: string }
): void {
  const remove = (instances: ReadonlyArray<FleetInstance>) =>
    instances.filter(
      (instance) =>
        instance.id !== deleted.instanceId ||
        instance.relayId !== deleted.relayId
    )
  updateRelaySnapshots(
    queryClient,
    (snapshot) =>
      snapshot
        ? { ...snapshot, instances: remove(snapshot.instances) }
        : snapshot,
    { removesServers: true }
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      hasRelaySnapshot(connection)
        ? {
            ...connection,
            snapshot: {
              ...connection.snapshot,
              instances: remove(connection.snapshot.instances),
            },
          }
        : connection
  )
  queryClient.setQueryData<Array<FleetInstance>>(
    queryKeys.relay.instances,
    (instances) => (instances ? remove(instances) : instances)
  )
}

export function applyRecoveredRelayConnection(
  queryClient: QueryClient,
  connection: RelayConnection
): Promise<void> {
  const snapshot =
    connection.status === "connected" || connection.status === "unreachable"
      ? connection.snapshot
      : { instances: [], nodes: [] }
  const cancellation = Promise.all(
    [
      queryKeys.relay.connection,
      queryKeys.relay.instances,
      queryKeys.relay.snapshot,
    ].map((queryKey) => queryClient.cancelQueries({ exact: true, queryKey }))
  ).then(() => undefined)
  queryClient.setQueryData(queryKeys.relay.instances, snapshot.instances)
  queryClient.setQueryData(queryKeys.relay.snapshot, snapshot)
  queryClient.setQueryData(queryKeys.relay.connection, connection)
  recheckPushedState(queryClient)
  return cancellation
}

/**
 * Whether anything on this page holds, reads, or is loading the fleet
 * snapshot. Stream recovery only needs a fresh fleet when it does.
 */
export function fleetCacheInUse(
  queryClient: QueryClient,
  instances: RelayInstancesCollection
): boolean {
  if (instances.status !== "idle" && instances.status !== "cleaned-up")
    return true
  return [
    queryKeys.relay.connection,
    queryKeys.relay.snapshot,
    queryKeys.relay.instances,
  ].some((queryKey) => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true })
    return (
      query !== undefined &&
      (query.state.data !== undefined ||
        query.getObserversCount() > 0 ||
        query.state.fetchStatus !== "idle")
    )
  })
}

/**
 * Whether a pushed fleet change arrived while the fleet's first read is in
 * flight. That read would overwrite the change when it lands, so the stream
 * recovers with an authoritative read instead.
 */
export function fleetEventNeedsRecovery(
  queryClient: QueryClient,
  instances: RelayInstancesCollection,
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
): boolean {
  if (event.type === "collections.invalidate") return false
  if (instances.status === "loading") return true
  return [
    queryKeys.relay.connection,
    queryKeys.relay.snapshot,
    queryKeys.relay.instances,
  ].some((queryKey) => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true })
    return (
      query !== undefined &&
      query.state.data === undefined &&
      query.state.fetchStatus !== "idle"
    )
  })
}

/**
 * Game server and Relay state refreshes only on pushed changes, and stream
 * recovery means some may have been missed. Recheck what is mounted.
 */
export function recheckPushedState(queryClient: QueryClient): void {
  recordReachabilityGap(queryClient)
  void queryClient.invalidateQueries({
    queryKey: queryKeys.relay.reachability,
    exact: true,
  })
  for (const kind of ["server", "relay"] as const)
    void recheckInstanceObservations(queryClient, {
      queryKey: instanceInventoryScope({ kind }),
    })
}

function applyRealtimeRelayStatus(
  connection: RelayConnection | undefined,
  snapshot: RelayFleetSnapshot | undefined,
  event: Extract<RealtimeClientEvent, { type: "relay.status" }>
): RelayConnection | undefined {
  if (
    !connection ||
    (connection.status !== "connected" && connection.status !== "unreachable")
  ) {
    return connection
  }
  const relays = connection.relays.map((relay) =>
    relay.id === event.relayId
      ? { ...relay, status: event.status, updating: event.updating ?? false }
      : relay
  )
  return connectionWithRelayStatuses(connection, snapshot, relays)
}

function hasRelaySnapshot(
  connection: RelayConnection | undefined
): connection is Extract<
  RelayConnection,
  { status: "connected" | "unreachable" }
> {
  return (
    connection?.status === "connected" || connection?.status === "unreachable"
  )
}

function connectionWithRelayStatuses(
  connection: Extract<
    RelayConnection,
    { status: "connected" } | { status: "unreachable" }
  >,
  snapshot: RelayFleetSnapshot | undefined,
  relays: Array<
    Extract<RelayConnection, { status: "connected" }>["relays"][number]
  >
): RelayConnection {
  const connectedCount = relays.filter(
    (relay) => relay.status === "connected"
  ).length
  const relay = relayConnectionSummary(relays)
  const recoveredSnapshot = snapshot ?? connection.snapshot
  if (connectedCount === 0) {
    return {
      message:
        relays.length === 1
          ? "The Relay is configured, but Hearth cannot reach it right now."
          : "Hearth cannot reach any configured Relay right now.",
      relay,
      relays,
      snapshot: recoveredSnapshot,
      status: "unreachable",
    }
  }
  return { relay, relays, snapshot: recoveredSnapshot, status: "connected" }
}

function relayConnectionSummary(
  relays: ReadonlyArray<{
    id: string
    name: string
    status: "connected" | "unreachable"
  }>
): { id: string; name: string } {
  const relay = relays[0]
  if (relays.length === 1 && relay) return { id: relay.id, name: relay.name }
  const connectedCount = relays.filter(
    (candidate) => candidate.status === "connected"
  ).length
  return {
    id: "relay-fleet",
    name: `${connectedCount}/${relays.length} Relays connected`,
  }
}

function upsertRelaySnapshotInstance(
  snapshot: RelayFleetSnapshot | undefined,
  updated: FleetInstance
): RelayFleetSnapshot | undefined {
  if (!snapshot) return snapshot
  if (
    snapshot.instances.some(
      (instance) =>
        instance.id === updated.id && instance.relayId === updated.relayId
    )
  ) {
    return replaceRelaySnapshotInstance(snapshot, updated)
  }
  return { ...snapshot, instances: [updated, ...snapshot.instances] }
}

function realtimeInstanceIdentityChanged(
  queryClient: QueryClient,
  event: Extract<RealtimeClientEvent, { type: "instances.delta" }>
): boolean {
  if (event.deleted.length > 0) return true
  const current =
    queryClient.getQueryData<RelayFleetSnapshot>(queryKeys.relay.snapshot)
      ?.instances ??
    queryClient.getQueryData<Array<FleetInstance>>(queryKeys.relay.instances) ??
    []
  const currentNames = new Map(
    current.map((instance) => [
      `${instance.relayId}:${instance.id}`,
      instance.name,
    ])
  )
  return event.upserted.some(
    (instance) =>
      currentNames.get(`${instance.relayId}:${instance.id}`) !== instance.name
  )
}

function mergeRealtimeInstance(
  current: FleetInstance | undefined,
  updated: FleetInstance
): FleetInstance {
  if (!current) return updated
  const endpointUnchanged =
    current.publicHost === updated.publicHost &&
    current.publicPort === updated.publicPort
  return {
    ...updated,
    connectAddress: endpointUnchanged
      ? current.connectAddress
      : updated.connectAddress,
  }
}

export function resetRealtimeEpoch(input: {
  currentEpoch: string | null
  nextEpoch: string
  recoveryFloor: number
}): { changed: boolean; epoch: string; recoveryFloor: number } {
  if (input.currentEpoch === input.nextEpoch) {
    return {
      changed: false,
      epoch: input.nextEpoch,
      recoveryFloor: input.recoveryFloor,
    }
  }
  return { changed: true, epoch: input.nextEpoch, recoveryFloor: 0 }
}

export function parseRealtimeEventData(data: unknown): unknown {
  if (typeof data !== "string") return null
  return Result.getOrNull(Result.try(() => JSON.parse(data) as unknown))
}
