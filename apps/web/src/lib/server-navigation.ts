import {
  findFirstCanonicalRelayInstance,
  relayInstanceRouteIdentifier,
  resolveCanonicalRelayInstance,
} from "@/lib/relay-selectors"

/**
 * Which game server the sidebar and command menu open: the one in the URL,
 * else the one last selected, else the first the user can reach.
 */
export type ServerNavigationInput =
  | { serverId: string }
  | { selectedRouteId: string | null }

export interface ServerNavigation<T> {
  instance: T | null
  // The shortest identifier that names the instance alone; null when the
  // short ID is shared and the instance has no Relay-qualified route.
  routeId: string | null
  // The requested identifier matches more than one instance.
  ambiguous: boolean
  serverCount: number
}

export function resolveServerNavigation<
  T extends { id: string; name: string; routeId?: string; shortId: string },
>(instances: Array<T>, input: ServerNavigationInput): ServerNavigation<T> {
  const serverId = "serverId" in input ? input.serverId : null
  const resolution = resolveCanonicalRelayInstance(
    instances,
    serverId ?? ("selectedRouteId" in input ? input.selectedRouteId : null)
  )
  const instance =
    resolution.status === "found"
      ? resolution.instance
      : serverId || resolution.status === "ambiguous"
        ? null
        : (findFirstCanonicalRelayInstance(instances) ?? null)
  return {
    instance,
    routeId: instance
      ? (relayInstanceRouteIdentifier(instances, instance) ?? null)
      : null,
    ambiguous: resolution.status === "ambiguous",
    serverCount: instances.length,
  }
}
