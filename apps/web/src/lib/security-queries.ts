import { queryOptions } from "@tanstack/react-query"

import { getResourceSecurity, getSecurityOverview } from "@/server/security"

// Everything under "security" reloads when the security topic changes.
export const securityQueryKeys = {
  all: ["security"] as const,
  overview: (scope: string | null) => ["security", "overview", scope] as const,
  resource: (scope: string) => ["security", "resource", scope] as const,
}

export function securityOverviewQueryOptions(scope: string | null) {
  return queryOptions({
    queryKey: securityQueryKeys.overview(scope),
    queryFn: ({ signal }) => getSecurityOverview({ data: { scope }, signal }),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
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
