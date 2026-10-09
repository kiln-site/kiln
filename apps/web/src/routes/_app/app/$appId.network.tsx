import { createFileRoute } from "@tanstack/react-router"

import { AppNetworkPage } from "@/components/app/app-network-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/network")({
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "network",
      params.appId
    )
  },
  component: AppNetworkPage,
  head: () => ({ meta: [{ title: pageTitle("Network") }] }),
})
