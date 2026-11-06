import { createFileRoute } from "@tanstack/react-router"
import {
  appFileRootId,
  appVolumeFileRootId,
  relayManagedVolumeIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { AppFilesPage } from "@/components/app/app-files-page"
import { filePageLocation, startFilePageReads } from "@/lib/file-page-reads"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/files")({
  // One of the app's volumes, open in place of its folder.
  validateSearch: z.object({
    volume: z
      .string()
      .optional()
      .transform((volume) =>
        relayManagedVolumeIdSchema.safeParse(volume).success
          ? volume
          : undefined
      ),
  }),
  loaderDeps: ({ search }) => ({ volume: search.volume }),
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "files",
      params.appId
    )
  },
  loader: ({ context, deps, location, params }) => {
    startFilePageReads(
      context.queryClient,
      {
        instanceId: deps.volume
          ? appVolumeFileRootId(context.app.id, deps.volume)
          : appFileRootId(context.app.id),
        relayId: context.app.relayId,
      },
      filePageLocation({ location, params })
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
  component: AppFilesPage,
  pendingMinMs: 0,
})
