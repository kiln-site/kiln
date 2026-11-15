import type { FleetRelayInstance, RelayFleetSnapshot } from "@/lib/relay-fleet"

export type TailscaleServer = Pick<
  FleetRelayInstance,
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

/** The Relays whose instances can join a tailnet, by ID: all of them. */
export function tailscaleSupportedRelayIds(
  snapshot: RelayFleetSnapshot
): Array<string> {
  return snapshot.nodes.map((node) => node.relayId).sort()
}

export function selectTailscaleServers(
  snapshot: RelayFleetSnapshot
): Array<TailscaleServer> {
  const supportedRelayIds = new Set(tailscaleSupportedRelayIds(snapshot))
  return snapshot.instances
    .map((instance) => ({
      brickId: instance.brickId,
      id: instance.id,
      implementation: instance.implementation,
      name: instance.name,
      relayId: instance.relayId,
      relayName: instance.relayName,
      version: instance.version,
      tailscaleSupported: supportedRelayIds.has(instance.relayId),
    }))
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
