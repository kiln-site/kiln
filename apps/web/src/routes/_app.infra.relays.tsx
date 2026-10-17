import { z } from "zod"
import { createFileRoute } from "@tanstack/react-router"

import { RelaysPage } from "@/components/relays-page"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/relays")({
  validateSearch: z.object({
    invitation: z.uuid().optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/relays"
    )
  },
  // A Hearth database read, so the first HTML can include every row.
  loader: async ({ context }) => {
    await context.dbClient.collection(relaysCollectionOptions).preload()
  },
  head: () => ({ meta: [{ title: pageTitle("Relays") }] }),
  component: InfraRelaysRoute,
})

function InfraRelaysRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <RelaysPage searchStore={searchStore} />
}
