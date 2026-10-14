import { createFileRoute } from "@tanstack/react-router"
import { RelayDatabasePage } from "@/components/relay/relay-database-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/database")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "database",
      params.relayId
    )
  },
  component: RelayDatabasePage,
  head: () => ({ meta: [{ title: pageTitle("Database") }] }),
})
