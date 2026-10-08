import { createFileRoute } from "@tanstack/react-router"

import { DatabaseTerminalPage } from "@/components/database/database-terminal-page"
import { pageTitle } from "@/lib/page-title"
import { requireDatabaseDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/terminal")({
  beforeLoad: async ({ context, params }) => {
    await requireDatabaseDestinationAccess(
      context.queryClient,
      context.database,
      "terminal",
      params.databaseId
    )
  },
  component: DatabaseTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Terminal") }] }),
})
