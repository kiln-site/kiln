import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ServersPage } from "@/components/servers-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { isDevelopmentBypassIdentity } from "@/lib/development-bypass"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/servers")({
  validateSearch: z.object({
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/servers"
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Servers") }] }),
  component: ServersRoute,
})

function ServersRoute() {
  const { search = "" } = Route.useSearch()
  const { user } = Route.useRouteContext()
  const searchStore = useDataTableSearchStore(search)

  return (
    <ServersPage
      canProvision={
        user.isDevelopmentBypass ||
        user.role === "admin" ||
        user.role === "relay_creator"
      }
      passwordRequired={!isDevelopmentBypassIdentity(user)}
      searchStore={searchStore}
    />
  )
}
