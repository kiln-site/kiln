import { createFileRoute } from "@tanstack/react-router"

import { RelayLogsPage } from "@/components/relay/relay-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/logs")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "logs",
      params.relayId
    )
  },
  component: RelayLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Logs") }] }),
})
