import { createFileRoute } from "@tanstack/react-router"
import { appFileRootId } from "@workspace/contracts"

import { AppFilesPage } from "@/components/app/app-files-page"
import { filePageLocation, startFilePageReads } from "@/lib/file-page-reads"
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
  loader: ({ context, location, params }) => {
    startFilePageReads(
      context.queryClient,
      {
        instanceId: appFileRootId(context.app.id),
        relayId: context.app.relayId,
      },
      filePageLocation({ location, params })
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
  component: AppFilesPage,
  pendingMinMs: 0,
})
