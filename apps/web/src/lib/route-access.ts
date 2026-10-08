import { redirect } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import {
  accessibleDestinationsForDatabase,
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  canAccessInfrastructureDestination,
  databaseDestinationHref,
  firstAccessibleAppHref,
  infrastructureDestinations,
  serverDestinationHref,
  type DatabaseDestinationId,
  type NavigationAccessCapabilities,
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

type RouteDatabase = Parameters<typeof accessibleDestinationsForDatabase>[0]

export async function requireDatabaseDestinationAccess(
  queryClient: QueryClient,
  database: RouteDatabase,
  destinationId: DatabaseDestinationId,
  routeId: string
): Promise<void> {
  const capabilities = await routeAccessCapabilities(queryClient)
  const destinations = accessibleDestinationsForDatabase(database, capabilities)
  if (destinations.some((destination) => destination.id === destinationId)) {
    return
  }
  const fallback = destinations[0]
  throw redirect({
    href: fallback
      ? databaseDestinationHref(fallback, routeId)
      : firstAccessibleAppHref(capabilities),
    replace: true,
  })
}

export async function redirectToFirstAccessibleDatabaseDestination(
  queryClient: QueryClient,
  database: RouteDatabase,
  routeId: string
): Promise<never> {
  const capabilities = await routeAccessCapabilities(queryClient)
  const destination = accessibleDestinationsForDatabase(
    database,
    capabilities
  )[0]
  throw redirect({
    href: destination
      ? databaseDestinationHref(destination, routeId)
      : firstAccessibleAppHref(capabilities),
    replace: true,
  })
}
