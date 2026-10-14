import { createFileRoute } from "@tanstack/react-router"

import { RelayProxyPage } from "@/components/relay/relay-proxy-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/proxy")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "proxy",
      params.relayId
    )
  },
  component: RelayProxyPage,
  head: () => ({ meta: [{ title: pageTitle("Proxy") }] }),
})
