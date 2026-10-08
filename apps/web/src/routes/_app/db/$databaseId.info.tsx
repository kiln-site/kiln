import { createFileRoute } from "@tanstack/react-router"

import { DatabaseInfoPage } from "@/components/database/database-info-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/info")({
  beforeLoad: async ({ context, params }) => {
    await requireDatabaseDestinationAccess(
      context.queryClient,
      context.database,
      "info",
      params.databaseId
    )
  },
  component: DatabaseInfoPage,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})
