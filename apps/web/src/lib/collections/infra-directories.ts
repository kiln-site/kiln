import { collectionOptions } from "@tanstack/react-db"
import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getInfraServerDirectory } from "@/server/infra-directory"

// Hearth's own records of each kind, permission-filtered, with no Relay
// round trip. Route loaders preload them, so tables render their rows in
// the first HTML and on navigation without a loading state. Each shares its
// query key with the matching directory query options used elsewhere.
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
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      getKey: (row) => `${row.relayId}:${row.id}`,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
    })
  )
}

export const infraServersCollectionOptions = infraDirectoryCollection(
  "infra-server-directory",
  queryKeys.servers.directory,
  (signal) => getInfraServerDirectory({ signal })
)
