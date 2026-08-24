import { createFileRoute } from "@tanstack/react-router"

import { DomainsPage } from "@/components/domains-page"
import { pageTitle } from "@/lib/page-title"
import { domainSettingsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/domains")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/domains"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(domainSettingsQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Domains") }] }),
  component: DomainsPage,
})
