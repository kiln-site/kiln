import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { InfraOverviewPage } from "@/components/infra-map"
import {
  infraAppsCollectionOptions,
  infraDatabasesCollectionOptions,
  infraServersCollectionOptions,
} from "@/lib/collections/infra-directories"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import {
  canAccessInfrastructureDestination,
  infrastructureDestinations,
} from "@/lib/navigation-destinations"
import { pageTitle } from "@/lib/page-title"
import {
  domainSettingsQueryOptions,
  hearthEdgeQueryOptions,
} from "@/lib/query-options"
import {
  requireInfrastructureDestinationAccess,
  routeAccessCapabilities,
} from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/overview")({
  validateSearch: z.object({
    scope: z.string().max(200).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/overview"
    )
  },
  // Hearth database reads only, so the first HTML draws the whole map.
  loader: async ({ context }) => {
    const capabilities = await routeAccessCapabilities(context.queryClient)
    const includeDomains = infrastructureDestinations.some(
      (destination) =>
        destination.to === "/infra/domains" &&
        canAccessInfrastructureDestination(capabilities, destination)
    )
    await Promise.all([
      context.dbClient.collection(relaysCollectionOptions).preload(),
      context.dbClient.collection(infraServersCollectionOptions).preload(),
      context.dbClient.collection(infraAppsCollectionOptions).preload(),
      context.dbClient.collection(infraDatabasesCollectionOptions).preload(),
      context.queryClient.ensureQueryData(hearthEdgeQueryOptions()),
      includeDomains
        ? context.queryClient.ensureQueryData(domainSettingsQueryOptions())
        : undefined,
    ])
    return { includeDomains }
  },
  head: () => ({ meta: [{ title: pageTitle("Infrastructure Overview") }] }),
  component: InfraOverviewRoute,
})

function InfraOverviewRoute() {
  const { includeDomains } = Route.useLoaderData()
  const { scope } = Route.useSearch()
  return (
    <InfraOverviewPage
      includeDomains={includeDomains}
      initialScope={scope}
    />
  )
}
