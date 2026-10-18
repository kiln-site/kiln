import { createFileRoute } from "@tanstack/react-router"

import { StartupWorkspace } from "@/components/startup-workspace"
import { pageTitle } from "@/lib/page-title"
import { instanceStartupQueryOptions } from "@/lib/query-options"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/startup")({
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "startup",
      params.serverId
    )
  },
  loader: ({ context }) => {
    // Start the page's read with the navigation, or on hover, without
    // holding it open. Relay reads stay out of SSR, as on Files.
    const { instance, queryClient } = context
    if (typeof window === "undefined" || !instance) return
    void queryClient.prefetchQuery(
      instanceStartupQueryOptions(instance.relayId, instance.id)
    )
  },
  component: StartupRoute,
  head: () => ({ meta: [{ title: pageTitle("Startup") }] }),
})

function StartupRoute() {
  return <StartupWorkspace />
}
