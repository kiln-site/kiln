import { createFileRoute } from "@tanstack/react-router"

import { redirectToFirstAccessibleRelayDestination } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/")({
  beforeLoad: async ({ context, params }) => {
    await redirectToFirstAccessibleRelayDestination(
      context.queryClient,
      context.relay,
      params.relayId
    )
  },
})
