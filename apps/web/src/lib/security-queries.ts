import { queryOptions } from "@tanstack/react-query"

import type { SecurityInventoryRef } from "@/lib/security"
import {
  getResourceSecurity,
  getSecurityOverview,
  getSecurityPackages,
} from "@/server/security"

// Everything under "security" reloads when the security topic changes.
export const securityQueryKeys = {
  all: ["security"] as const,
  packages: (inventory: SecurityInventoryRef) =>
    ["security", "packages", inventory.relayId, inventory.sbomKey] as const,
  overview: (scope: string | null, own = false) =>
    ["security", "overview", scope, own] as const,
  resource: (scope: string) => ["security", "resource", scope] as const,
}

export function securityOverviewQueryOptions(
  scope: string | null,
  own = false
) {
  return queryOptions({
    queryKey: securityQueryKeys.overview(scope, own),
    queryFn: ({ signal }) =>
      getSecurityOverview({ data: { own, scope }, signal }),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  })
}

export function securityPackagesQueryOptions(inventory: SecurityInventoryRef) {
  return queryOptions({
    queryKey: securityQueryKeys.packages(inventory),
    queryFn: ({ signal }) => getSecurityPackages({ data: inventory, signal }),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })
}

export function resourceSecurityQueryOptions(scope: string) {
  return queryOptions({
    queryKey: securityQueryKeys.resource(scope),
    queryFn: ({ signal }) => getResourceSecurity({ data: { scope }, signal }),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })
}
