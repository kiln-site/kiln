import { collectionOptions } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getManagedDatabaseDirectory } from "@/server/databases"

export const managedDatabaseDirectoryCollectionOptions = collectionOptions(
  "managed-database-directory",
  (client) =>
    queryCollectionOptions({
      id: "managed-database-directory",
      getKey: (database) => `${database.relayId}:${database.id}`,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getManagedDatabaseDirectory(),
      queryKey: queryKeys.databases.directory,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    })
)
