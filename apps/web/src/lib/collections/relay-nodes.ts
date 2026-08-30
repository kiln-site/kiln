import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { fleetNodeSchema } from "@/lib/realtime-events"
import { fetchRelaySnapshot, queryKeys } from "@/lib/query-options"

export const relayNodesCollectionOptions = collectionOptions(
  "relay-nodes",
  (client) =>
    queryCollectionOptions({
      id: "relay-nodes",
      getKey: (node) => node.relayId,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: ({ client: queryClient }) => fetchRelaySnapshot(queryClient),
      queryKey: queryKeys.relay.snapshot,
      refetchOnWindowFocus: false,
      schema: fleetNodeSchema,
      select: (snapshot) => snapshot.nodes,
      staleTime: 5_000,
    })
)

export function getRelayNodesCollection(client: DbClient) {
  return client.collection(relayNodesCollectionOptions)
}
