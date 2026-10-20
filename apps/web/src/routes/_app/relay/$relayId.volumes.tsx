import { createFileRoute } from "@tanstack/react-router"

import { RelayVolumesPage } from "@/components/relay/relay-volumes-page"
import { pageTitle } from "@/lib/page-title"
import { relayVolumesQueryOptions } from "@/lib/query-options"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/volumes")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "volumes",
      params.relayId
    )
  },
  loader: ({ context }) => {
    // Started while the page renders; the table shows its loading rows.
    void context.queryClient.prefetchQuery(
      relayVolumesQueryOptions(context.relay.id)
    )
  },
  component: RelayVolumesPage,
  head: () => ({ meta: [{ title: pageTitle("Volumes") }] }),
})
