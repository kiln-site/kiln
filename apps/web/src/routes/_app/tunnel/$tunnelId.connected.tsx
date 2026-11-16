import { createFileRoute } from "@tanstack/react-router"

import { TunnelConnectedPage } from "@/components/tunnel/tunnel-connected-page"
import { pageTitle } from "@/lib/page-title"
import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/connected")({
  beforeLoad: ({ context }) =>
    requireTunnelDestinationAccess(context.tunnel, "connected"),
  component: TunnelConnectedPage,
  head: () => ({ meta: [{ title: pageTitle("Connected") }] }),
})
