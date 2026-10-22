import { redirect } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import {
  accessibleDestinationsForApp,
  accessibleDestinationsForDatabase,
  accessibleDestinationsForRelay,
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  canAccessInfrastructureDestination,
  appDestinationHref,
  databaseDestinationHref,
  firstAccessibleAppHref,
  infrastructureDestinations,
  relayDestinationHref,
  serverDestinationHref,
  type AppDestinationId,
  type DatabaseDestinationId,
  type NavigationAccessCapabilities,
  type RelayDestinationId,
  type ServerDestinationId,
} from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

type GlobalProtectedDestination =
  | "access"
  | "activity"
  | "automations"
  | "backups"

export async function routeAccessCapabilities(
  queryClient: QueryClient
): Promise<NavigationAccessCapabilities> {
  return queryClient.ensureQueryData(accessCapabilitiesQueryOptions())
}

export async function requireGlobalDestinationAccess(
  queryClient: QueryClient,
  destination: GlobalProtectedDestination
): Promise<void> {
  const capabilities = await routeAccessCapabilities(queryClient)
  const allowed =
    destination === "access"
      ? capabilities.canManageAccess
      : destination === "activity"
        ? canAccessActivity(capabilities)
        : destination === "automations"
          ? canAccessAutomations(capabilities)
          : canAccessBackups(capabilities)
  if (allowed) return
  throw redirect({ href: firstAccessibleAppHref(capabilities), replace: true })
}

export async function requireInfrastructureSectionAccess(
  queryClient: QueryClient
): Promise<void> {
  const capabilities = await routeAccessCapabilities(queryClient)
  if (accessibleInfrastructureDestinations(capabilities).length > 0) return
  throw redirect({ href: firstAccessibleAppHref(capabilities), replace: true })
}

export async function requireInfrastructureDestinationAccess(
  queryClient: QueryClient,
  to: (typeof infrastructureDestinations)[number]["to"]
): Promise<void> {
  const capabilities = await routeAccessCapabilities(queryClient)
  const destination = infrastructureDestinations.find(
    (candidate) => candidate.to === to
  )
  if (
    destination &&
    canAccessInfrastructureDestination(capabilities, destination)
  ) {
    return
  }
  const fallback =
    accessibleInfrastructureDestinations(capabilities)[0]?.to ??
    firstAccessibleAppHref(capabilities)
  throw redirect({ href: fallback, replace: true })
}

export async function requireServerDestinationAccess(
  queryClient: QueryClient,
  instance: { brickId: string | undefined; id: string; relayId: string } | null,
  destinationId: ServerDestinationId,
  routeId: string
): Promise<void> {
  if (!instance) return
  const capabilities = await routeAccessCapabilities(queryClient)
  const destinations = accessibleDestinationsForServer(instance, capabilities)
  if (destinations.some((destination) => destination.id === destinationId)) {
    return
  }
  const fallback = destinations[0]
  if (fallback) {
    throw redirect({
      href: serverDestinationHref(fallback, routeId),
      replace: true,
    })
  }
  throw redirect({ href: firstAccessibleAppHref(capabilities), replace: true })
}

export async function redirectToFirstAccessibleServerDestination(
  queryClient: QueryClient,
  instance: { brickId: string | undefined; id: string; relayId: string } | null,
  routeId: string
): Promise<never> {
  if (!instance) {
    throw redirect({
      href: `/server/${encodeURIComponent(routeId)}/console`,
      replace: true,
    })
  }
  const capabilities = await routeAccessCapabilities(queryClient)
  const destination = accessibleDestinationsForServer(instance, capabilities)[0]
  if (destination) {
    throw redirect({
      href: serverDestinationHref(destination, routeId),
      replace: true,
    })
  }
  throw redirect({ href: firstAccessibleAppHref(capabilities), replace: true })
}

// Allows a workspace destination the person can open. Otherwise, or when no
// destination is asked for, redirects to the first one they can open, or out
// of the workspace.
async function requireResourceDestination<D extends { id: string }>(
  queryClient: QueryClient,
  destinations: (
    capabilities: NavigationAccessCapabilities
  ) => ReadonlyArray<D>,
  href: (destination: D) => string,
  destinationId?: D["id"]
): Promise<void> {
  const capabilities = await routeAccessCapabilities(queryClient)
  const accessible = destinations(capabilities)
  if (accessible.some((destination) => destination.id === destinationId)) {
    return
  }
  const fallback = accessible[0]
  throw redirect({
    href: fallback ? href(fallback) : firstAccessibleAppHref(capabilities),
    replace: true,
  })
}

type RouteDatabase = Parameters<typeof accessibleDestinationsForDatabase>[0]

export function requireDatabaseDestinationAccess(
  queryClient: QueryClient,
  database: RouteDatabase,
  destinationId: DatabaseDestinationId,
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForDatabase(database, capabilities),
    (destination) => databaseDestinationHref(destination, routeId),
    destinationId
  )
}

export function redirectToFirstAccessibleDatabaseDestination(
  queryClient: QueryClient,
  database: RouteDatabase,
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForDatabase(database, capabilities),
    (destination) => databaseDestinationHref(destination, routeId)
  )
}

export function requireAppDestinationAccess(
  queryClient: QueryClient,
  app: { id: string; relayId: string },
  destinationId: AppDestinationId,
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForApp(app, capabilities),
    (destination) => appDestinationHref(destination, routeId),
    destinationId
  )
}

export function redirectToFirstAccessibleAppDestination(
  queryClient: QueryClient,
  app: { id: string; relayId: string },
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForApp(app, capabilities),
    (destination) => appDestinationHref(destination, routeId)
  )
}

export function requireRelayDestinationAccess(
  queryClient: QueryClient,
  relay: { id: string },
  destinationId: RelayDestinationId,
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForRelay(relay, capabilities),
    (destination) => relayDestinationHref(destination, routeId),
    destinationId
  )
}

export function redirectToFirstAccessibleRelayDestination(
  queryClient: QueryClient,
  relay: { id: string },
  routeId: string
): Promise<void> {
  return requireResourceDestination(
    queryClient,
    (capabilities) => accessibleDestinationsForRelay(relay, capabilities),
    (destination) => relayDestinationHref(destination, routeId)
  )
}
