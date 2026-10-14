import { createFileRoute } from "@tanstack/react-router"
import { RelayFilesPage } from "@/components/relay/relay-files-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/files")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "files",
      params.relayId
    )
  },
  component: RelayFilesPage,
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
})
