import { createFileRoute } from "@tanstack/react-router"

import { AppOverviewPage } from "@/components/app/app-overview-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/overview")({
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "overview",
      params.appId
    )
  },
  component: AppOverviewPage,
  head: () => ({ meta: [{ title: pageTitle("Overview") }] }),
})
