import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { fleetInstanceSchema } from "@/lib/realtime-events"
import { queryKeys } from "@/lib/query-options"
import { getRelayInstances } from "@/server/relay"

export const relayInstancesCollectionOptions = collectionOptions(
  "relay-instances",
  (client) =>
    queryCollectionOptions({
      id: "relay-instances",
      getKey: fleetInstanceKey,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getRelayInstances(),
      queryKey: queryKeys.relay.instances,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      schema: fleetInstanceSchema,
      startSync: true,
      staleTime: Infinity,
    })
)

export function fleetInstanceKey(instance: {
  id: string
  relayId: string
}): string {
  return `${instance.relayId}:${instance.id}`
}

export function getRelayInstancesCollection(client: DbClient) {
  return client.collection(relayInstancesCollectionOptions)
}

export type RelayInstancesCollection = ReturnType<
  typeof getRelayInstancesCollection
>
