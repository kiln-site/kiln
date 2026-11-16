import { createFileRoute } from "@tanstack/react-router"

import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/")({
  beforeLoad: ({ context }) => requireTunnelDestinationAccess(context.tunnel),
})
