import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { InstanceNetworkPage } from "@/components/instance-network-page"
import { pageTitle } from "@/lib/page-title"
import {
  accessCapabilitiesQueryOptions,
  instanceWebRoutesQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
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
  loader: ({ context }) => {
    // Start the page's reads with the navigation, or on hover, without
    // holding it open. Relay reads stay out of SSR, as on Files.
    const { instance, queryClient } = context
    if (typeof window === "undefined" || !instance) return
    void queryClient.prefetchQuery(
      instanceWebRoutesQueryOptions(instance.relayId, instance.id)
    )
    const capabilities = queryClient.getQueryData(
      accessCapabilitiesQueryOptions().queryKey
    )
    if (capabilities?.isPlatformAdmin)
      void queryClient.prefetchQuery(tailscaleStacksQueryOptions())
  },
  component: NetworkRoute,
  head: () => ({ meta: [{ title: pageTitle("Network") }] }),
})

function NetworkRoute() {
  const { edit } = Route.useSearch()

  return <InstanceNetworkPage editGamePort={edit === "game-port"} />
}
