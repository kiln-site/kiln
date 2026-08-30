import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getManagedDatabases } from "@/server/databases"

export const managedDatabasesCollectionOptions = collectionOptions(
  "managed-databases",
  (client) =>
    queryCollectionOptions({
      id: "managed-databases",
      getKey: managedDatabaseKey,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getManagedDatabases(),
      queryKey: queryKeys.databases.list,
      refetchOnWindowFocus: "always",
      select: (overview) => overview.databases,
      staleTime: 5_000,
    })
)

export function managedDatabaseKey(database: {
  id: string
  relayId: string
}): string {
  return `${database.relayId}:${database.id}`
}

export function getManagedDatabasesCollection(client: DbClient) {
  return client.collection(managedDatabasesCollectionOptions)
}
