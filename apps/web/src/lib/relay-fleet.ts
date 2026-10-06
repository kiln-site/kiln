import { projectRelayInstanceOverview } from "@workspace/contracts"
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
    ...projectRelayInstanceOverview(instance),
    relayId: relay.id,
    relayName: relay.name,
    relayStatus,
    routeId: relayInstanceRouteId(relay.id, instance.shortId),
  }
}
