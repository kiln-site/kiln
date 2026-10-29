import { queryOptions } from "@tanstack/react-query"

import {
  getResourceDeletion,
  listVolumeDeletions,
} from "@/server/resource-deletions"

export interface ResourceDeletionTarget {
  kind: "app" | "database" | "instance" | "volume"
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

/**
 * The deletions of a Relay's Kiln volumes that are running or stopped,
 * under the same realtime topic.
 */
export function volumeDeletionsQueryOptions(relayId: string) {
  return queryOptions({
    queryKey: ["resource-deletion", "volumes", relayId] as const,
    queryFn: ({ signal }) => listVolumeDeletions({ data: { relayId }, signal }),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  })
}
