import * as React from "react"
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
    app: z.string().max(64).optional(),
    relay: z.string().max(64).optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
    server: z.string().max(64).optional(),
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
  const { app, relay, search = "", server } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)
  // Read once: the page keeps the filter and writes the URL itself.
  const [initialScope] = React.useState(() =>
    server
      ? { instanceId: server, kind: "server" as const, relayId: relay }
      : app
        ? { instanceId: app, kind: "app" as const, relayId: relay }
        : null
  )

  return <DomainsPage initialScope={initialScope} searchStore={searchStore} />
}
