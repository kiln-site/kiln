import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getAppDirectory } from "@/server/apps"
import { getManagedDatabaseDirectory } from "@/server/databases"

export const infraAppsCollectionOptions = collectionOptions(
  "infra-app-directory",
  (client) =>
    queryCollectionOptions({
      queryKey: queryKeys.apps.directory,
      queryFn: ({ signal }) => getAppDirectory({ signal }),
      staleTime: 30_000,
      id: "infra-app-directory",
      getKey: (row) => `${row.relayId}:${row.id}`,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
    })
)

export const infraDatabasesCollectionOptions = collectionOptions(
  "infra-database-directory",
  (client) =>
    queryCollectionOptions({
      queryKey: queryKeys.databases.directory,
      queryFn: ({ signal }) => getManagedDatabaseDirectory({ signal }),
      staleTime: 30_000,
      id: "infra-database-directory",
      getKey: (row) => `${row.relayId}:${row.id}`,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
    })
)

export const getInfraAppsCollection = (client: DbClient) =>
  client.collection(infraAppsCollectionOptions)
export const getInfraDatabasesCollection = (client: DbClient) =>
  client.collection(infraDatabasesCollectionOptions)
