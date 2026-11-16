import { createFileRoute } from "@tanstack/react-router"

import { TunnelTerminalPage } from "@/components/tunnel/tunnel-terminal-page"
import { pageTitle } from "@/lib/page-title"
import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/terminal")({
  beforeLoad: ({ context }) =>
    requireTunnelDestinationAccess(context.tunnel, "terminal"),
  component: TunnelTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Terminal") }] }),
})
