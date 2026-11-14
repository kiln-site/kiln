import { createFileRoute } from "@tanstack/react-router"

import { ServerTerminalPage } from "@/components/server/server-terminal-page"
import { pageTitle } from "@/lib/page-title"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/terminal")({
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "terminal",
      params.serverId
    )
  },
  component: ServerTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Terminal") }] }),
})
