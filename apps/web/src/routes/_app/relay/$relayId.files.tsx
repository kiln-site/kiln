import { createFileRoute } from "@tanstack/react-router"
import { RelayFilesPage } from "@/components/relay/relay-files-page"
import { relayHostAccessQueryOptions } from "@/components/relay/relay-host-access"
import { filePageLocation, startFilePageReads } from "@/lib/file-page-reads"
import { pageTitle } from "@/lib/page-title"
import { renderRead } from "@/lib/render-reads"
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
  loader: ({ context, location, params }) => {
    const { queryClient, relay } = context
    // The page opens once the Relay allows host files; Hearth checks each
    // read itself, so they start alongside that check.
    void queryClient.prefetchQuery(
      renderRead("host-access", relayHostAccessQueryOptions(relay.id))
    )
    startFilePageReads(
      queryClient,
      { instanceId: relay.id, relayId: relay.id },
      filePageLocation({ location, params })
    )
  },
  component: RelayFilesPage,
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
})
