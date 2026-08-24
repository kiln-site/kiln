import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  DatabasesPage,
  createDatabaseSearchStore,
} from "@/components/databases-page"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/databases")({
  validateSearch: z.object({ search: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/databases"
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Databases") }] }),
  component: InfraDatabasesRoute,
})

function InfraDatabasesRoute() {
  const { search = "" } = Route.useSearch()
  const [searchStore] = React.useState(() => createDatabaseSearchStore(search))

  React.useLayoutEffect(() => {
    searchStore.set(search)
  }, [search, searchStore])

  return <DatabasesPage searchStore={searchStore} />
}
