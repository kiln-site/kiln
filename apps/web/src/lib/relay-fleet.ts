import { projectRelayServerOverview } from "@workspace/contracts"
import type { RelayServer, RelayNode } from "@workspace/contracts"

export type RelayReachability = "connected" | "unreachable"

export interface FleetRelayServer extends RelayServer {
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
  instances: Array<FleetRelayServer>
  nodes: Array<FleetRelayNode>
}

export function relayFleetServer(
  instance: RelayServer,
  relay: { id: string; name: string },
  relayStatus: RelayReachability = "connected"
): FleetRelayServer {
  return {
    ...projectRelayServerOverview(instance),
    relayId: relay.id,
    relayName: relay.name,
    relayStatus,
  }
}
