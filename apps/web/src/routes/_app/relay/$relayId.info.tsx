import { createFileRoute } from "@tanstack/react-router"

import { RelayInfoPage } from "@/components/relay/relay-info-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/info")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "info",
      params.relayId
    )
  },
  component: RelayInfoPage,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})
