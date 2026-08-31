import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getRelays } from "@/server/relays"

export const relaysCollectionOptions = collectionOptions(
  "hearth-relays",
  (client) =>
    queryCollectionOptions({
      id: "hearth-relays",
      getKey: (relay) => relay.id,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getRelays(),
      queryKey: queryKeys.relays,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    })
)

export function getRelaysCollection(client: DbClient) {
  return client.collection(relaysCollectionOptions)
}
