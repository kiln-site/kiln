import type { QueryClient } from "@tanstack/react-query"

import type { RelayInstancesCollection } from "@/lib/collections/relay-instances"
import { refreshHearthRealtimeTopics } from "@/lib/hearth-realtime"
import type { hearthRealtimeTopics } from "@/lib/hearth-realtime-topics"
import {
  queryKeys,
  replaceRelaySnapshotInstance,
  type RelayConnection,
} from "@/lib/query-options"
import type { FleetInstance, RealtimeClientEvent } from "@/lib/realtime-events"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

export function applyRealtimeEvent(input: {
  event: Exclude<RealtimeClientEvent, { type: "relay.invalidate" | "reset" }>
  instances: RelayInstancesCollection
  queryClient: QueryClient
  refreshTopics?: (
    topics: ReadonlyArray<(typeof hearthRealtimeTopics)[number]>
  ) => Promise<void>
}): void {
  const { event, instances, queryClient, refreshTopics } = input
  if (event.type === "collections.invalidate") {
    void (
      refreshTopics?.(event.topics) ??
      refreshHearthRealtimeTopics(queryClient, event.topics)
    )
    return
  }
  queryClient.setQueryData<RelayFleetSnapshot>(
    queryKeys.relay.snapshot,
    (snapshot) => applyRealtimeSnapshotEvent(snapshot, event)
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      connection?.status === "connected"
        ? {
            ...connection,
            snapshot:
              applyRealtimeSnapshotEvent(connection.snapshot, event) ??
              connection.snapshot,
          }
        : connection
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
      instances.utils.writeDelete(
        event.deleted.map(
          ({ instanceId, relayId }) => `${relayId}:${instanceId}`
        )
      )
    })
  }
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
    (snapshot) => replaceRelaySnapshotInstance(snapshot, updated)
  )
  queryClient.setQueryData<RelayConnection>(
    queryKeys.relay.connection,
    (connection) =>
      connection?.status === "connected"
        ? {
            ...connection,
            snapshot:
              replaceRelaySnapshotInstance(connection.snapshot, updated) ??
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
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}
