import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AppsPage } from "@/components/apps-page"
import { getAppsCollection } from "@/lib/collections/apps"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/apps")({
  validateSearch: z.object({
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  ssr: false,
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/apps"
    )
  },
  loader: async ({ context }) => {
    await getAppsCollection(context.dbClient).preload()
  },
  head: () => ({ meta: [{ title: pageTitle("Apps") }] }),
  component: InfraAppsRoute,
})

function InfraAppsRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <AppsPage searchStore={searchStore} />
}
