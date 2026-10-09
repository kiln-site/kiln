import { createFileRoute } from "@tanstack/react-router"

import { AppFilesPage } from "@/components/app/app-files-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/files")({
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "files",
      params.appId
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
  component: AppFilesPage,
  pendingMinMs: 0,
})
