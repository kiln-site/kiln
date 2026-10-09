import { createFileRoute } from "@tanstack/react-router"

import { DatabaseLogsPage } from "@/components/database/database-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/logs")({
  beforeLoad: async ({ context, params }) => {
    await requireDatabaseDestinationAccess(
      context.queryClient,
      context.database,
      "logs",
      params.databaseId
    )
  },
  component: DatabaseLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Logs") }] }),
})
