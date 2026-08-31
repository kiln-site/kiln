import { createFileRoute } from "@tanstack/react-router"

import { RelaysPage } from "@/components/relays-page"
import { getRelaysCollection } from "@/lib/collections/relays"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/relays")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/relays"
    )
  },
  loader: ({ context }) => getRelaysCollection(context.dbClient).preload(),
  head: () => ({ meta: [{ title: pageTitle("Relays") }] }),
  component: RelaysPage,
})
