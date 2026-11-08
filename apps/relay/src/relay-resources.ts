import {
  APP_SERVICE,
  appFileRootId,
  appIdFromFileRoot,
} from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import {
  legacyInstanceId,
  physicalKey,
  physicalShortKey,
} from "./instance-keys.js"

export const RELAY_OWNER_LABEL = "kiln.relay.owner"

export interface RelayResourceNames {
  // The name an app's service answers to on its network, which routes and
  // connections reach it by. An App from before 12-character IDs keeps the
  // one its old ID gave it, which its running containers already have.
  appAlias(appId: string, service: string): string
  // Every name it answers to there: that one, and for an App from before
  // 12-character IDs, the one its new ID gives it too.
  appAliases(appId: string, service: string): Array<string>
  // The Compose project an App's Compose deployments run as. A rolled
  // deployment runs as `<project>-<deployment>` until it takes over.
  appComposeProject(appId: string): string
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

  const appAlias = (key: string, service: string) =>
    service === APP_SERVICE ? `app-${key}` : `${service}.app-${key}`

  // Names derived from an instance's ID use its physical key, so one from
  // before 12-character IDs keeps the resources it has (instance-keys.ts).
  return {
    appAlias: (appId, service) => appAlias(physicalShortKey(appId), service),
    appAliases: (appId, service) =>
      legacyInstanceId(appId)
        ? [appAlias(physicalShortKey(appId), service), appAlias(appId, service)]
        : [appAlias(appId, service)],
    appComposeProject: (appId) => name(`kiln-app-${physicalKey(appId)}`),
    appNetwork: (appId) => name(`kiln-app-${physicalKey(appId)}-network`),
    coreDnsContainer: name("kiln-coredns"),
    edgeNetwork: name("kiln-edge"),
    gameNetwork: name("kiln-minecraft"),
    instanceContainer: (instanceId) =>
      name(`kiln-${physicalShortKey(instanceId)}`),
    limboContainer: name("kiln-limbo"),
    relayEdgeAlias: "kiln-relay",
    relayEdgeNetwork: name("kiln-relay-edge"),
    tailscaleContainer: name("kiln-tailscale"),
    tailscaleStackContainer: (stackId) =>
      name(`kiln-ts-${physicalShortKey(stackId)}`),
    tailscaleStackDnsContainer: (stackId) =>
      name(`kiln-ts-${physicalShortKey(stackId)}-dns`),
    tailscaleStackNetwork: (stackId) =>
      name(`kiln-ts-${physicalShortKey(stackId)}-network`),
    traefikContainer: name("kiln-traefik"),
  }
}

export { APP_SERVICE }

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

/** `relayOwnerLabel` as labels to merge into a resource's. */
export function relayOwnerLabels(
  config: Pick<RelayConfig, "resourceNamespace">
): Record<string, string> {
  return config.resourceNamespace
    ? { [RELAY_OWNER_LABEL]: config.resourceNamespace }
    : {}
}

export function relayOwnsLabels(
  config: Pick<RelayConfig, "resourceNamespace">,
  labels: Readonly<Record<string, string | undefined>> | null
): boolean {
  const owner = labels?.[RELAY_OWNER_LABEL]
  return config.resourceNamespace ? owner === config.resourceNamespace : !owner
}
