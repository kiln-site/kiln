import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { fetchApps, queryKeys } from "@/lib/query-options"

export const appsCollectionOptions = collectionOptions("apps", (client) =>
  queryCollectionOptions({
    id: "apps",
    getKey: appKey,
    queryClient: client.requireDependency<QueryClient>("queryClient"),
    queryFn: ({ client }) => fetchApps(client),
    queryKey: queryKeys.apps.list,
    refetchOnWindowFocus: "always",
    // Deployments run on the Relay; follow them until they finish.
    refetchInterval: (query) =>
      query.state.data?.apps.some((app) => app.deployment?.state === "running")
        ? 2_000
        : false,
    select: (overview) => overview.apps,
    staleTime: 5_000,
  })
)

export function appKey(app: { id: string; relayId: string }): string {
  return `${app.relayId}:${app.id}`
}

export function getAppsCollection(client: DbClient) {
  return client.collection(appsCollectionOptions)
}
