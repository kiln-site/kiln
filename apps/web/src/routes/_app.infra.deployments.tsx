import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  appIdSchema,
  instanceIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
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
import { deploymentsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/deployments")({
  validateSearch: z.object({
    // One App's deployments, one game server's, or one Relay's.
    appId: appIdSchema.optional(),
    serverId: instanceIdSchema.optional(),
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
    serverId: search.serverId,
  }),
  loader: ({ context, deps }) => {
    // Started while the page renders; the table shows its loading rows.
    void context.queryClient.prefetchInfiniteQuery(
      deploymentsQueryOptions(scopeOf(deps))
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Deployments") }] }),
  component: InfraDeploymentsRoute,
})

function scopeOf(search: {
  appId?: string
  relayId?: string
  serverId?: string
}): AppDeploymentsScope {
  const relay = search.relayId ? { relayId: search.relayId } : {}
  return search.appId
    ? { instance: { id: search.appId, kind: "app" }, ...relay }
    : search.serverId
      ? { instance: { id: search.serverId, kind: "server" }, ...relay }
      : relay
}

function InfraDeploymentsRoute() {
  const { appId, relayId, search = "", serverId } = Route.useSearch()
  const searchStore = useDataTableSearchStore(search)
  const navigate = Route.useNavigate()
  const scope = React.useMemo(
    () => scopeOf({ appId, relayId, serverId }),
    [appId, relayId, serverId]
  )
  const changeScope = React.useCallback(
    (next: AppDeploymentsScope) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          appId: next.instance?.kind === "app" ? next.instance.id : undefined,
          relayId: next.relayId,
          serverId:
            next.instance?.kind === "server" ? next.instance.id : undefined,
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
