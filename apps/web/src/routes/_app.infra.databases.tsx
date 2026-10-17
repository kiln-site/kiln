import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { DatabasesPage } from "@/components/databases-page"
import { getInfraDatabasesCollection } from "@/lib/collections/infra-directories"
import { forkPromise } from "@/effect/promise"
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
  loader: ({ context }) => {
    if (typeof window !== "undefined")
      forkPromise(() => getInfraDatabasesCollection(context.dbClient).preload())
  },
  head: () => ({ meta: [{ title: pageTitle("Databases") }] }),
  component: InfraDatabasesRoute,
})

function InfraDatabasesRoute() {
  const { search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)

  return <DatabasesPage searchStore={searchStore} />
}
