import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { fleetInstanceSchema } from "@/lib/realtime-events"
import { queryKeys } from "@/lib/query-options"
import { getRelayServers } from "@/server/relay"

export const relayServersCollectionOptions = collectionOptions(
  "relay-servers",
  (client) =>
    queryCollectionOptions({
      id: "relay-servers",
      getKey: fleetInstanceKey,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getRelayServers(),
      queryKey: queryKeys.relay.instances,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      schema: fleetInstanceSchema,
      staleTime: Infinity,
    })
)

export function fleetInstanceKey(instance: {
  id: string
  relayId: string
}): string {
  return `${instance.relayId}:${instance.id}`
}

export function getRelayServersCollection(client: DbClient) {
  return client.collection(relayServersCollectionOptions)
}

export type RelayServersCollection = ReturnType<
  typeof getRelayServersCollection
>
