import type { QueryClient } from "@tanstack/react-query"
import { Result } from "effect"

import type { RelayInstancesCollection } from "@/lib/collections/relay-instances"
import { refreshHearthRealtimeTopics } from "@/lib/hearth-realtime"
import type {
  HearthRealtimeScope,
  hearthRealtimeTopics,
} from "@/lib/hearth-realtime-topics"
import {
  queryKeys,
  replaceRelaySnapshotInstance,
  type RelayConnection,
} from "@/lib/query-options"
import type { FleetInstance, RealtimeClientEvent } from "@/lib/realtime-events"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

export interface ApplyRealtimeEventInput {
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
  instances: RelayInstancesCollection
  queryClient: QueryClient
  refreshTopics?: (
    topics: ReadonlyArray<(typeof hearthRealtimeTopics)[number]>,
    scope?: HearthRealtimeScope
  ) => Promise<void>
}

export function applyRealtimeEvent(input: ApplyRealtimeEventInput): void {
  const { event, instances, queryClient, refreshTopics } = input
  if (event.type === "collections.invalidate") {
    void (
      refreshTopics?.(event.topics, event.scope) ??
      refreshHearthRealtimeTopics(queryClient, event.topics, event.scope)
    )
    return
  }
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
      return connection?.status === "connected"
        ? {
            ...connection,
            snapshot:
              applyRealtimeSnapshotEvent(connection.snapshot, event) ??
              connection.snapshot,
          }
        : connection
    }
  )
  if (event.type === "instances.delta") {
    if (!instances.isReady()) {
      const snapshot = queryClient.getQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot
      )
      queryClient.setQueryData<Array<FleetInstance>>(
        queryKeys.relay.instances,
        (current) =>
          applyRealtimeInstancesEvent(
            current ?? snapshot?.instances ?? [],
            event
          )
      )
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
    return
  }
  if (event.type === "relay.status") {
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
      instance.relayId === event.relayId &&
      instance.relayStatus !== event.status
        ? [{ ...instance, relayStatus: event.status }]
        : []
    )
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

export function applyRealtimeSnapshotEvent(
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
        instance.relayId === event.relayId &&
        instance.relayStatus !== event.status
          ? { ...instance, relayStatus: event.status }
          : instance
      ),
      nodes: snapshot.nodes.map((node) =>
        node.relayId === event.relayId && node.relayStatus !== event.status
          ? { ...node, relayStatus: event.status }
          : node
      ),
    }
  }
  return {
    ...snapshot,
    instances: applyRealtimeInstancesEvent(snapshot.instances, event),
  }
}

export function applyRealtimeInstancesEvent(
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
      connection?.status === "connected"
        ? {
            ...connection,
            snapshot:
              upsertRelaySnapshotInstance(connection.snapshot, updated) ??
              connection.snapshot,
          }
        : connection
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
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) =>
      snapshot
        ? { ...snapshot, instances: remove(snapshot.instances) }
        : snapshot
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      connection?.status === "connected"
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
  return cancellation
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
    relay.id === event.relayId ? { ...relay, status: event.status } : relay
  )
  return connectionWithRelayStatuses(connection, snapshot, relays)
}

function connectionWithRelayStatuses(
  connection: Extract<
    RelayConnection,
    { status: "connected" } | { status: "unreachable" }
  >,
  snapshot: RelayFleetSnapshot | undefined,
  relays: Array<{
    id: string
    name: string
    status: "connected" | "unreachable"
  }>
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

export function mergeRealtimeInstance(
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
