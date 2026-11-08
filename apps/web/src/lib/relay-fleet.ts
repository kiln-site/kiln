import { projectRelayInstanceOverview } from "@workspace/contracts"
import type { RelayInstance, RelayNode } from "@workspace/contracts"

export type RelayReachability = "connected" | "unreachable"

export interface FleetRelayInstance extends RelayInstance {
  relayId: string
  relayName: string
  relayStatus: RelayReachability
  relayUpdating?: boolean
}

export interface FleetRelayNode extends RelayNode {
  relayId: string
  relayName: string
  relayStatus: RelayReachability
  relayUpdating?: boolean
}

export interface RelayFleetSnapshot {
  instances: Array<FleetRelayInstance>
  nodes: Array<FleetRelayNode>
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
  }
}
