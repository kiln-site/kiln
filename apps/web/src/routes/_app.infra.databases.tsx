import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { DatabasesPage } from "@/components/databases-page"
import { infraDatabasesCollectionOptions } from "@/lib/collections/infra-directories"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/databases")({
  validateSearch: z.object({
    invitation: z.uuid().optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/databases"
    )
  },
  // Hearth database reads, so the first HTML can include every row and
  // the create action.
  loader: async ({ context }) => {
    await Promise.all([
      context.dbClient.collection(infraDatabasesCollectionOptions).preload(),
      context.queryClient.ensureQueryData(
        infraRelayOptionsQueryOptions("database")
      ),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Databases") }] }),
  component: InfraDatabasesRoute,
})

function InfraDatabasesRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <DatabasesPage searchStore={searchStore} />
}
