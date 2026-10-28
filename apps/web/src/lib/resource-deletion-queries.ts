import { queryOptions } from "@tanstack/react-query"

import { getResourceDeletion } from "@/server/resource-deletions"

export interface ResourceDeletionTarget {
  kind: "database" | "instance"
  relayId: string
  resourceId: string
}

/**
 * A resource's deletion while it runs or after it stopped, kept fresh by the
 * `resource-deletions` realtime topic.
 */
export function resourceDeletionQueryOptions(target: ResourceDeletionTarget) {
  return queryOptions({
    queryKey: [
      "resource-deletion",
      target.kind,
      target.relayId,
      target.resourceId,
    ] as const,
    queryFn: ({ signal }) => getResourceDeletion({ data: target, signal }),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })
}
