import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { DomainsPage } from "@/components/domains-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { domainSettingsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/domains")({
  validateSearch: z.object({
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/domains"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(domainSettingsQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Domains") }] }),
  component: InfraDomainsRoute,
})

function InfraDomainsRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <DomainsPage searchStore={searchStore} />
}
