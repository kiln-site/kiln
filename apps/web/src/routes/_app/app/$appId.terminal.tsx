import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AppTerminalPage } from "@/components/app/app-terminal-page"
import { pageTitle } from "@/lib/page-title"
import { requireAppDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/app/$appId/terminal")({
  validateSearch: z.object({ service: z.string().max(64).optional() }),
  beforeLoad: async ({ context, params }) => {
    await requireAppDestinationAccess(
      context.queryClient,
      context.app,
      "terminal",
      params.appId
    )
  },
  component: AppTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Terminal") }] }),
})
