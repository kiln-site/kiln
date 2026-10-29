import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { infraServersCollectionOptions } from "@/lib/collections/infra-directories"
import { ServersPage } from "@/components/servers-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/servers")({
  validateSearch: z.object({
    invitation: z.uuid().optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/servers"
    )
  },
  // A Hearth database read, so the first HTML can include every row.
  loader: async ({ context }) => {
    await context.dbClient.collection(infraServersCollectionOptions).preload()
  },
  head: () => ({ meta: [{ title: pageTitle("Game Servers") }] }),
  component: ServersRoute,
})

function ServersRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return (
    <ServersPage searchStore={searchStore} />
  )
}
