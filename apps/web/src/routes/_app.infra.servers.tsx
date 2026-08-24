import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ServersPage, createServerSearchStore } from "@/components/servers-page"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/servers")({
  validateSearch: z.object({
    search: z.string().optional(),
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
  const [searchStore] = React.useState(() => createServerSearchStore(search))

  React.useLayoutEffect(() => {
    searchStore.set(search)
  }, [search, searchStore])

  return (
    <ServersPage
      canProvision={
        user.isDevelopmentBypass ||
        user.role === "admin" ||
        user.role === "relay_creator"
      }
      searchStore={searchStore}
    />
  )
}
