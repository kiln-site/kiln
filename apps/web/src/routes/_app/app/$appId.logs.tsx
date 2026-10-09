import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AppLogsPage } from "@/components/app/app-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/logs")({
  // `deployment`, or `service:<name>` for a service's container output.
  validateSearch: z.object({ stream: z.string().max(128).optional() }),
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "logs",
      params.appId
    )
  },
  component: AppLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Logs") }] }),
})
