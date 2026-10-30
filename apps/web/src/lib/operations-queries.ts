import { queryOptions } from "@tanstack/react-query"

import { getOperationsOverview } from "@/server/operations"

/**
 * Hearth's operations, for the operator view. Realtime says when they
 * change; while any runs, it's read again every few seconds so a missed
 * update doesn't leave it stale.
 */
export function operationsOverviewQueryOptions() {
  return queryOptions({
    queryKey: ["operations", "overview"],
    queryFn: () => getOperationsOverview(),
    refetchInterval: (query) =>
      query.state.data?.running.length ? 5_000 : false,
    staleTime: 2_000,
  })
}
