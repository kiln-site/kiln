import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { relaysQueryOptions } from "@/lib/query-options"
import { relayRouteIdentifier, resolveRelayRoute } from "@/lib/relay-route"

export const Route = createFileRoute("/_app/relay/$relayId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    let relays = await context.queryClient.ensureQueryData(relaysQueryOptions())
    let resolution = resolveRelayRoute(relays, params.relayId)
    if (resolution.status === "not-found") {
      // A Relay paired moments ago may not be in the cached list yet.
      relays = await context.queryClient.fetchQuery({
        ...relaysQueryOptions(),
        staleTime: 0,
      })
      resolution = resolveRelayRoute(relays, params.relayId)
    }
    if (resolution.status !== "found") {
      throw redirect({
        href: `/infra/relays?search=${encodeURIComponent(params.relayId)}`,
        replace: true,
      })
    }
    const relay = resolution.resource
    const routeIdentifier = relayRouteIdentifier(relays, relay)
    if (params.relayId !== routeIdentifier) {
      const segments = location.pathname.split("/")
      segments[2] = encodeURIComponent(routeIdentifier)
      throw redirect({
        href: `${segments.join("/")}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
        replace: true,
      })
    }
    return { relay: { id: relay.id } }
  },
  component: Outlet,
})
