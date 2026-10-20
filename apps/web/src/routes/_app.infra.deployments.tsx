import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { appIdSchema, relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  AppDeploymentsPage,
  type AppDeploymentsScope,
} from "@/components/app-deployments-page"
import {
  DATA_TABLE_SEARCH_MAX_LENGTH,
  useDataTableSearchStore,
} from "@/lib/data-table-search"
import { pageTitle } from "@/lib/page-title"
import { appDeploymentsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/deployments")({
  validateSearch: z.object({
    // One app's deployments, or one Relay's apps'.
    appId: appIdSchema.optional(),
    relayId: relayIdSchema.optional(),
    search: z.string().max(DATA_TABLE_SEARCH_MAX_LENGTH).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/deployments"
    )
  },
  loaderDeps: ({ search }) => ({
    appId: search.appId,
    relayId: search.relayId,
  }),
  loader: ({ context, deps }) => {
    // Started while the page renders; the table shows its loading rows.
    void context.queryClient.prefetchInfiniteQuery(
      appDeploymentsQueryOptions(scopeOf(deps))
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Deployments") }] }),
  component: InfraDeploymentsRoute,
})

function scopeOf(search: {
  appId?: string
  relayId?: string
}): AppDeploymentsScope {
  return search.appId && search.relayId
    ? { appId: search.appId, relayId: search.relayId }
    : search.relayId
      ? { relayId: search.relayId }
      : {}
}

function InfraDeploymentsRoute() {
  const { appId, relayId, search = "" } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)
  const navigate = Route.useNavigate()
  const scope = React.useMemo(
    () => scopeOf({ appId, relayId }),
    [appId, relayId]
  )
  const changeScope = React.useCallback(
    (next: AppDeploymentsScope) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          appId: next.appId,
          relayId: next.relayId,
        }),
      })
    },
    [navigate]
  )
  return (
    <AppDeploymentsPage
      scope={scope}
      searchStore={searchStore}
      onScopeChange={changeScope}
    />
  )
}
