import type { QueryClient } from "@tanstack/react-query"
import type { InstanceKind } from "@workspace/contracts"

import { instanceInventoryScope } from "@/lib/instance-inventory"
import { queryKeys } from "@/lib/query-options"

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
  ])
}
