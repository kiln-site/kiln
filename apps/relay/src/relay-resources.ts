import { appFileRootId, appIdFromFileRoot } from "@workspace/contracts"

import type { RelayConfig } from "./config.js"

export const RELAY_OWNER_LABEL = "kiln.relay.owner"

export interface RelayResourceNames {
  // The name an app's service answers to on its network.
  appAlias(appId: string, service: string): string
  appNetwork(appId: string): string
  coreDnsContainer: string
  edgeNetwork: string
  gameNetwork: string
  instanceContainer(instanceId: string): string
  limboContainer: string
  relayEdgeAlias: string
  relayEdgeNetwork: string
  tailscaleContainer: string
  tailscaleStackContainer(stackId: string): string
  tailscaleStackDnsContainer(stackId: string): string
  tailscaleStackNetwork(stackId: string): string
  traefikContainer: string
}

export function relayResourceNames(
  config: Pick<RelayConfig, "resourceNamespace">
): RelayResourceNames {
  const name = (legacyName: string): string =>
    config.resourceNamespace
      ? `${config.resourceNamespace}-${legacyName}`
      : legacyName

  return {
    appAlias: (appId, service) =>
      service === APP_SERVICE
        ? `app-${appId.slice(0, 8)}`
        : `${service}.app-${appId.slice(0, 8)}`,
    appNetwork: (appId) => name(`kiln-app-${appId}-network`),
    coreDnsContainer: name("kiln-coredns"),
    edgeNetwork: name("kiln-edge"),
    gameNetwork: name("kiln-minecraft"),
    instanceContainer: (instanceId) => name(`kiln-${instanceId.slice(0, 8)}`),
    limboContainer: name("kiln-limbo"),
    relayEdgeAlias: "kiln-relay",
    relayEdgeNetwork: name("kiln-relay-edge"),
    tailscaleContainer: name("kiln-tailscale"),
    tailscaleStackContainer: (stackId) =>
      name(`kiln-ts-${stackId.slice(0, 8)}`),
    tailscaleStackDnsContainer: (stackId) =>
      name(`kiln-ts-${stackId.slice(0, 8)}-dns`),
    tailscaleStackNetwork: (stackId) =>
      name(`kiln-ts-${stackId.slice(0, 8)}-network`),
    traefikContainer: name("kiln-traefik"),
  }
}

// Image and Dockerfile apps run one service under this name.
export const APP_SERVICE = "app"

// App web routes are stored owned by `app:<appId>`, the key files use for an
// app's data directory, so they never collide with a server's.
export const appRouteOwner = appFileRootId
export const appIdFromRouteOwner = appIdFromFileRoot

export function relayOwnerLabel(
  config: Pick<RelayConfig, "resourceNamespace">
): string | null {
  return config.resourceNamespace
    ? `${RELAY_OWNER_LABEL}=${config.resourceNamespace}`
    : null
}

export function relayOwnsLabels(
  config: Pick<RelayConfig, "resourceNamespace">,
  labels: Readonly<Record<string, string | undefined>> | null
): boolean {
  const owner = labels?.[RELAY_OWNER_LABEL]
  return config.resourceNamespace ? owner === config.resourceNamespace : !owner
}
