import { createFileRoute } from "@tanstack/react-router"

import { RelaysPage } from "@/components/relays-page"
import { pageTitle } from "@/lib/page-title"
import { relaysQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/relays")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/relays"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(relaysQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Relays") }] }),
  component: RelaysPage,
})
