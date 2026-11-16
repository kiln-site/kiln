import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TunnelsPage } from "@/components/tunnel/tunnels-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { tailnetsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/tunnels")({
  validateSearch: z.object({
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/tunnels"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(tailnetsQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Tunnels") }] }),
  component: InfraTunnelsRoute,
})

function InfraTunnelsRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <TunnelsPage searchStore={searchStore} />
}
