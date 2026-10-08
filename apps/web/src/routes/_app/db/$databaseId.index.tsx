import { createFileRoute } from "@tanstack/react-router"

import { redirectToFirstAccessibleDatabaseDestination } from "@/lib/route-access"

export const Route = createFileRoute("/_app/db/$databaseId/")({
  beforeLoad: async ({ context, params }) => {
    await redirectToFirstAccessibleDatabaseDestination(
      context.queryClient,
      context.database,
      params.databaseId
    )
  },
})
