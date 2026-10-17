import { collectionOptions, type DbClient } from "@tanstack/react-db"
import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getInfraServerDirectory } from "@/server/infra-directory"
import { getAppDirectory } from "@/server/apps"
import { getManagedDatabaseDirectory } from "@/server/databases"

function infraDirectoryCollection<T extends { id: string; relayId: string }>(
  id: string,
  queryKey: QueryKey,
  load: (signal: AbortSignal) => Promise<Array<T>>
) {
  return collectionOptions(id, (client) =>
    queryCollectionOptions({
      id,
      queryKey,
      queryFn: ({ signal }) => load(signal),
      staleTime: 30_000,
      getKey: (row) => `${row.relayId}:${row.id}`,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
    })
  )
}

export const infraAppsCollectionOptions = infraDirectoryCollection(
  "infra-app-directory",
  queryKeys.apps.directory,
  (signal) => getAppDirectory({ signal })
)
export const infraDatabasesCollectionOptions = infraDirectoryCollection(
  "infra-database-directory",
  queryKeys.databases.directory,
  (signal) => getManagedDatabaseDirectory({ signal })
)
export const infraServersCollectionOptions = infraDirectoryCollection(
  "infra-server-directory",
  queryKeys.servers.directory,
  (signal) => getInfraServerDirectory({ signal })
)
export const getInfraAppsCollection = (client: DbClient) =>
  client.collection(infraAppsCollectionOptions)
export const getInfraDatabasesCollection = (client: DbClient) =>
  client.collection(infraDatabasesCollectionOptions)
export const getInfraServersCollection = (client: DbClient) =>
  client.collection(infraServersCollectionOptions)
