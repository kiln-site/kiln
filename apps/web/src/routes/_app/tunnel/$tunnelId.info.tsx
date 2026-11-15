import { createFileRoute } from "@tanstack/react-router"

import { TunnelInfoPage } from "@/components/tunnel/tunnel-info-page"
import { pageTitle } from "@/lib/page-title"
import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/info")({
  beforeLoad: ({ context }) =>
    requireTunnelDestinationAccess(context.tunnel, "info"),
  component: TunnelInfoPage,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})
