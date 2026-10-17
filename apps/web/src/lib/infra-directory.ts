import { queryOptions, type QueryClient } from "@tanstack/react-query"
import type { InstanceKind } from "@workspace/contracts"

import { instanceInventoryScope } from "@/lib/instance-inventory"
import { queryKeys } from "@/lib/query-options"
import { getInfraRelayOptions } from "@/server/infra-directory"

export function infraRelayOptionsQueryOptions(kind: "app" | "database") {
  return queryOptions({
    queryKey: ["infra-directory", "relays", kind],
    queryFn: ({ signal }) => getInfraRelayOptions({ data: kind, signal }),
    staleTime: 30_000,
  })
}

const directoryKeys = {
  app: queryKeys.apps.directory,
  database: queryKeys.databases.directory,
  server: queryKeys.servers.directory,
  relay: queryKeys.relays,
} satisfies Record<InstanceKind, ReadonlyArray<string>>

/** Refetches a table's rows and the observations its mounted cells read. */
export function refreshInfraTable(
  queryClient: QueryClient,
  kind: InstanceKind
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: directoryKeys[kind],
      exact: true,
    }),
    queryClient.invalidateQueries({
      queryKey: instanceInventoryScope({ kind }),
    }),
    kind === "app" || kind === "database"
      ? queryClient.invalidateQueries({
          queryKey: infraRelayOptionsQueryOptions(kind).queryKey,
        })
      : undefined,
  ])
}
