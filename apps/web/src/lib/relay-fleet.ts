import type { RelayInstance, RelayNode } from "@workspace/contracts"

export type RelayReachability = "connected" | "unreachable"

export interface FleetRelayInstance extends RelayInstance {
  relayId: string
  relayName: string
  relayStatus: RelayReachability
  routeId: string
}

export interface FleetRelayNode extends RelayNode {
  relayId: string
  relayName: string
  relayStatus: RelayReachability
}

export interface RelayFleetSnapshot {
  instances: Array<FleetRelayInstance>
  nodes: Array<FleetRelayNode>
}

export function relayInstanceRouteId(relayId: string, shortId: string): string {
  return `${relayId}-${shortId}`
}

export function relayFleetInstance(
  instance: RelayInstance,
  relay: { id: string; name: string },
  relayStatus: RelayReachability = "connected"
): FleetRelayInstance {
  return {
    ...instance,
    relayId: relay.id,
    relayName: relay.name,
    relayStatus,
    routeId: relayInstanceRouteId(relay.id, instance.shortId),
  }
}

export function addRelayInstanceToSnapshot(
  snapshot: RelayFleetSnapshot | undefined,
  instance: RelayInstance,
  relay: { id: string; name: string }
): RelayFleetSnapshot | undefined {
  if (!snapshot) return snapshot

  const relayInstance = relayFleetInstance(instance, relay)
  const existingIndex = snapshot.instances.findIndex(
    (item) => item.id === instance.id && item.relayId === relay.id
  )
  if (existingIndex !== -1) return snapshot

  return {
    ...snapshot,
    instances: [relayInstance, ...snapshot.instances],
  }
}
