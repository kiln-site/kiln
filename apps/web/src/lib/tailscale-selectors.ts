import { builtinTailscaleBrickId } from "@workspace/contracts"

import type { FleetRelayInstance, RelayFleetSnapshot } from "@/lib/relay-fleet"

export type TailscaleServer = Pick<
  FleetRelayInstance,
  | "id"
  | "implementation"
  | "name"
  | "relayId"
  | "relayName"
  | "routeId"
  | "shortId"
  | "version"
> & {
  tailscaleSupported: boolean
}

export function selectTailscaleServers(
  snapshot: RelayFleetSnapshot
): Array<TailscaleServer> {
  const supportedRelayIds = new Set(
    snapshot.nodes.flatMap((node) =>
      node.capabilities.includes("tailscale-stacks") &&
      node.capabilities.includes("tailscale-staged-removal")
        ? [node.relayId]
        : []
    )
  )
  return snapshot.instances
    .flatMap((instance) =>
      instance.brickId === builtinTailscaleBrickId
        ? []
        : [
            {
              id: instance.id,
              implementation: instance.implementation,
              name: instance.name,
              relayId: instance.relayId,
              relayName: instance.relayName,
              routeId: instance.routeId,
              shortId: instance.shortId,
              version: instance.version,
              tailscaleSupported: supportedRelayIds.has(instance.relayId),
            },
          ]
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function defaultTailscaleHostname(
  server: Pick<TailscaleServer, "name" | "shortId">
): string {
  const slug = server.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  return slug || server.shortId
}

export function tailscaleServerKey(
  relayId: string,
  instanceId: string
): string {
  return `${relayId}:${instanceId}`
}
