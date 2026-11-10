import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { DatabaseLogsPage } from "@/components/database/database-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/logs")({
  validateSearch: z.object({
    // One deployment's log, by its record. It takes precedence over `stream`.
    deployment: z.string().max(64).optional(),
    // `deployment` for the latest one; absent for the container's output.
    stream: z.string().max(128).optional(),
  }),
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
