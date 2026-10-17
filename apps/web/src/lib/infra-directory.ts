import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { getInfraRelayOptions } from "@/server/infra-directory"
import { queryKeys } from "@/lib/query-options"

export function infraRelayOptionsQueryOptions(kind: "app" | "database") {
  return queryOptions({
    queryKey: ["infra-directory", "relays", kind],
    queryFn: ({ signal }) => getInfraRelayOptions({ data: kind, signal }),
    staleTime: 30_000,
  })
}

/** Refresh only the active consumers; inactive resource details stay lazy. */
export function refreshInfraTable(
  queryClient: QueryClient,
  kind: "app" | "database" | "server" | "relay"
) {
  const keys =
    kind === "app"
      ? [queryKeys.apps.directory, queryKeys.apps.list]
      : kind === "database"
        ? [queryKeys.databases.directory, queryKeys.databases.list]
        : kind === "server"
          ? [queryKeys.servers.directory]
          : [queryKeys.relays]
  return Promise.all([
    ...keys.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, exact: true })
    ),
    queryClient.invalidateQueries({ queryKey: ["instance-states", kind] }),
    queryClient.invalidateQueries({ queryKey: ["instance-inventory", kind] }),
    queryClient.invalidateQueries({
      queryKey: ["infra-directory", "relays", kind],
    }),
  ])
}
