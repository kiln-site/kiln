import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import {
  relayConnectionQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import { renderRead } from "@/lib/render-reads"

export const Route = createFileRoute("/_app/relay/$relayId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
    const relays =
      await context.queryClient.ensureQueryData(relaysQueryOptions())
    // A Relay paired moments ago may not be in the cached list yet.
    const relay =
      relays.find((candidate) => candidate.id === params.relayId) ??
      (
        await context.queryClient.fetchQuery({
          ...relaysQueryOptions(),
          staleTime: 0,
        })
      ).find((candidate) => candidate.id === params.relayId)
    if (!relay) throw redirect({ to: "/infra/relays", replace: true })
    return { relay: { id: relay.id } }
  },
  loader: ({ context: { queryClient } }) => {
    // A Relay's pages wait on whether Hearth reaches it, so that check
    // starts with the navigation, and streams in while Hearth renders.
    void queryClient.prefetchQuery(
      renderRead("relay-connection", relayConnectionQueryOptions(queryClient))
    )
  },
  component: Outlet,
})
