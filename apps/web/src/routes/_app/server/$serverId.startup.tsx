import { createFileRoute } from "@tanstack/react-router"

import { StartupWorkspace } from "@/components/startup-workspace"
import { pageTitle } from "@/lib/page-title"
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
  component: StartupRoute,
  head: () => ({ meta: [{ title: pageTitle("Startup") }] }),
})

function StartupRoute() {
  return <StartupWorkspace />
}
