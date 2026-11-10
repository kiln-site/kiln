import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ServerLogsPage } from "@/components/server/server-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/logs")({
  validateSearch: z.object({
    // One deployment's log, by its record. Absent, it is the latest.
    deployment: z.string().max(64).optional(),
  }),
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "logs",
      params.serverId
    )
  },
  component: ServerLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Logs") }] }),
})
