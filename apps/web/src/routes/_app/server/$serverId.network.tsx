import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { InstanceNetworkPage } from "@/components/instance-network-page"
import { pageTitle } from "@/lib/page-title"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/network")({
  validateSearch: z.object({
    edit: z.enum(["game-port"]).optional(),
  }),
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "network",
      params.serverId
    )
  },
  component: NetworkRoute,
  head: () => ({ meta: [{ title: pageTitle("Network") }] }),
})

function NetworkRoute() {
  const { edit } = Route.useSearch()

  return <InstanceNetworkPage editGamePort={edit === "game-port"} />
}
