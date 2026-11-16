import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TunnelLogsPage } from "@/components/tunnel/tunnel-logs-page"
import { pageTitle } from "@/lib/page-title"
import { requireTunnelDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tunnel/$tunnelId/logs")({
  validateSearch: z.object({
    // One deployment's log, by its record. It takes precedence over `stream`.
    deployment: z.string().max(64).optional(),
    // `deployment` for the latest one, or one gateway's container as
    // `<gateway>:tailscale` or `<gateway>:coredns`; absent for the first
    // gateway's Tailscale.
    stream: z.string().max(128).optional(),
  }),
  beforeLoad: ({ context }) =>
    requireTunnelDestinationAccess(context.tunnel, "logs"),
  component: TunnelLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Logs") }] }),
})
