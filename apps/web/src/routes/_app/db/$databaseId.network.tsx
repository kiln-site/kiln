import { createFileRoute } from "@tanstack/react-router"

import { DatabaseNetworkPage } from "@/components/database/database-network-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/network")({
  beforeLoad: async ({ context, params }) => {
    await requireDatabaseDestinationAccess(
      context.queryClient,
      context.database,
      "network",
      params.databaseId
    )
  },
  component: DatabaseNetworkPage,
  head: () => ({ meta: [{ title: pageTitle("Network") }] }),
})
