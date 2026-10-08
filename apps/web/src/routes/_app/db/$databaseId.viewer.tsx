import { createFileRoute } from "@tanstack/react-router"

import { DatabaseViewerPage } from "@/components/database/database-viewer-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/viewer")({
  beforeLoad: async ({ context, params }) => {
    await requireDatabaseDestinationAccess(
      context.queryClient,
      context.database,
      "viewer",
      params.databaseId
    )
  },
  component: DatabaseViewerPage,
  head: () => ({ meta: [{ title: pageTitle("Viewer") }] }),
})
