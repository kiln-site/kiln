import { createFileRoute } from "@tanstack/react-router"

import { TunnelGatewaysPage } from "@/components/tunnel/tunnel-gateways-page"
import { pageTitle } from "@/lib/page-title"
import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/gateways")({
  beforeLoad: ({ context }) =>
    requireTunnelDestinationAccess(context.tunnel, "gateways"),
  component: TunnelGatewaysPage,
  head: () => ({ meta: [{ title: pageTitle("Gateways") }] }),
})
