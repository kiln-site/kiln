import { createFileRoute } from "@tanstack/react-router"
import { RelayTerminalPage } from "@/components/relay/relay-terminal-page"
import { pageTitle } from "@/lib/page-title"
import { requireRelayDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/relay/$relayId/terminal")({
  beforeLoad: async ({ context, params }) => {
    await requireRelayDestinationAccess(
      context.queryClient,
      context.relay,
      "terminal",
      params.relayId
    )
  },
  component: RelayTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Terminal") }] }),
})
