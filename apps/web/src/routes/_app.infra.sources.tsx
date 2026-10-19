import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { SourcesPage } from "@/components/sources-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { githubSourcesQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/sources")({
  validateSearch: z.object({
    // Opens Add source, as Sync's button does.
    add: z.boolean().optional(),
    // Where GitHub's setup redirects land, with the outcome to show once.
    connected: z.uuid().optional(),
    githubError: z.string().max(300).optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/sources"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(githubSourcesQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Sources") }] }),
  component: InfraSourcesRoute,
})

function InfraSourcesRoute() {
  const { add = false, connected, githubError, search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)
  const navigate = Route.useNavigate()
  const clearSetupResult = React.useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        connected: undefined,
        githubError: undefined,
      }),
    })
  }, [navigate])
  const setAddOpen = React.useCallback(
    (open: boolean) => {
      void navigate({
        replace: !open,
        search: (previous) => ({ ...previous, add: open ? true : undefined }),
      })
    },
    [navigate]
  )

  return (
    <SourcesPage
      addOpen={add}
      connected={connected}
      error={githubError}
      searchStore={searchStore}
      onAddOpenChange={setAddOpen}
      onSetupResultShown={clearSetupResult}
    />
  )
}
