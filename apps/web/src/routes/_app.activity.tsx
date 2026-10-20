import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  ActivityPage,
  createActivityFiltersStore,
} from "@/components/activity-page"
import type { ActivityFilters } from "@/components/activity-page"
import {
  activityInstantSchema,
  activityScopeKinds,
  activitySources,
  activityTypes,
} from "@/lib/activity"
import {
  infraAppsCollectionOptions,
  infraDatabasesCollectionOptions,
  infraServersCollectionOptions,
} from "@/lib/collections/infra-directories"
import { activityQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"
import { requireGlobalDestinationAccess } from "@/lib/route-access"

const activitySearchSchema = z
  .object({
    app: z.string().max(64).optional(),
    database: z.string().max(64).optional(),
    from: activityInstantSchema.optional(),
    q: z.string().max(160).optional(),
    relay: z.string().max(64).optional(),
    scope: z.enum(activityScopeKinds).optional(),
    server: z.string().max(64).optional(),
    source: z.enum(activitySources).optional(),
    to: activityInstantSchema.optional(),
    type: z.enum(activityTypes).optional(),
    user: z.string().max(64).optional(),
  })
  .refine(
    ({ from, to }) =>
      from === undefined ||
      to === undefined ||
      Date.parse(from) <= Date.parse(to),
    "Activity start must be before its end"
  )

export const Route = createFileRoute("/_app/activity")({
  validateSearch: activitySearchSchema,
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  beforeLoad: async ({ context }) => {
    await requireGlobalDestinationAccess(context.queryClient, "activity")
  },
  // The scope picker lists every instance from Hearth's own directories.
  loader: async ({ context, deps }) => {
    const [data] = await Promise.all([
      context.queryClient.ensureQueryData(
        activityQueryOptions(deps.from, deps.to)
      ),
      context.dbClient.collection(infraServersCollectionOptions).preload(),
      context.dbClient.collection(infraAppsCollectionOptions).preload(),
      context.dbClient.collection(infraDatabasesCollectionOptions).preload(),
    ])
    return data
  },
  head: () => ({ meta: [{ title: pageTitle("Activity") }] }),
  component: ActivityRoute,
})

function ActivityRoute() {
  const filters = Route.useSearch()
  const initialData = Route.useLoaderData()
  const [filterStore] = React.useState(() =>
    createActivityFiltersStore(filters)
  )
  React.useLayoutEffect(
    () => filterStore.setFilters(filters),
    [filterStore, filters]
  )
  const updateFilters = React.useCallback(
    (change: Partial<ActivityFilters>) => {
      const nextFilters = { ...filterStore.getSnapshot(), ...change }
      filterStore.setFilters(nextFilters)
      replaceActivityFilterSearch(nextFilters)
    },
    [filterStore]
  )
  return (
    <ActivityPage
      initialData={initialData}
      filterStore={filterStore}
      onFiltersChange={updateFilters}
    />
  )
}

function replaceActivityFilterSearch(filters: ActivityFilters): void {
  const url = new URL(window.location.href)
  setActivitySearchParam(url, "app", filters.app)
  setActivitySearchParam(url, "database", filters.database)
  setActivitySearchParam(url, "from", filters.from)
  setActivitySearchParam(url, "q", filters.q)
  setActivitySearchParam(url, "relay", filters.relay)
  setActivitySearchParam(url, "scope", filters.scope)
  setActivitySearchParam(url, "server", filters.server)
  setActivitySearchParam(url, "source", filters.source)
  setActivitySearchParam(url, "to", filters.to)
  setActivitySearchParam(url, "type", filters.type)
  setActivitySearchParam(url, "user", filters.user)
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

function setActivitySearchParam(
  url: URL,
  key: keyof ActivityFilters,
  value: string | undefined
): void {
  if (value) url.searchParams.set(key, value)
  else url.searchParams.delete(key)
}
