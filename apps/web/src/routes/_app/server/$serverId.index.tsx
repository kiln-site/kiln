import { createFileRoute } from "@tanstack/react-router"

import { redirectToFirstAccessibleServerDestination } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/")({
  beforeLoad: async ({ context, params }) => {
    await redirectToFirstAccessibleServerDestination(
      context.queryClient,
      context.instance,
      params.serverId
    )
  },
})
