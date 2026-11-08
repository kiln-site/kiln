import { builtinTailscaleBrickId } from "@workspace/contracts"

import type { FleetRelayServer, RelayFleetSnapshot } from "@/lib/relay-fleet"

export type TailscaleServer = Pick<
  FleetRelayServer,
  | "brickId"
  | "id"
  | "implementation"
  | "name"
  | "relayId"
  | "relayName"
  | "version"
> & {
  tailscaleSupported: boolean
}

/** The Relays that can change their Tailscale memberships, by ID. */
export function tailscaleSupportedRelayIds(
  snapshot: RelayFleetSnapshot
): Array<string> {
  return snapshot.nodes
    .flatMap((node) =>
      node.capabilities.includes("tailscale-stacks") &&
      node.capabilities.includes("tailscale-staged-removal")
        ? [node.relayId]
        : []
    )
    .sort()
}

export function selectTailscaleServers(
  snapshot: RelayFleetSnapshot
): Array<TailscaleServer> {
  const supportedRelayIds = new Set(tailscaleSupportedRelayIds(snapshot))
  return snapshot.instances
    .flatMap((instance) =>
      instance.brickId === builtinTailscaleBrickId
        ? []
        : [
            {
              brickId: instance.brickId,
              id: instance.id,
              implementation: instance.implementation,
              name: instance.name,
              relayId: instance.relayId,
              relayName: instance.relayName,
              version: instance.version,
              tailscaleSupported: supportedRelayIds.has(instance.relayId),
            },
          ]
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function defaultTailscaleHostname(
  server: Pick<TailscaleServer, "id" | "name">
): string {
  const slug = server.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  return slug || server.id
}

export function tailscaleServerKey(
  relayId: string,
  instanceId: string
): string {
  return `${relayId}:${instanceId}`
}
