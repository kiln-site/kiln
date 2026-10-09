import { createFileRoute } from "@tanstack/react-router"

import { redirectToFirstAccessibleAppDestination } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/")({
  beforeLoad: async ({ context, params }) => {
    await redirectToFirstAccessibleAppDestination(
      context.queryClient,
      context.app,
      params.appId
    )
  },
})
