import { createFileRoute } from "@tanstack/react-router"

import { AppBackupsPage } from "@/components/app/app-backups-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/backups")({
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "backups",
      params.appId
    )
  },
  component: AppBackupsPage,
  head: () => ({ meta: [{ title: pageTitle("Backups") }] }),
})
