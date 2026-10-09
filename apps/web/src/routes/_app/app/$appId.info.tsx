import { createFileRoute } from "@tanstack/react-router"

import { AppInfoPage } from "@/components/app/app-info-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/info")({
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "info",
      params.appId
    )
  },
  component: AppInfoPage,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})
