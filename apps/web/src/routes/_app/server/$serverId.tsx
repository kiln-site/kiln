import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import {
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import {
  relayInstanceRouteIdentifier,
  resolveRelayInstance,
} from "@/lib/relay-selectors"

export const Route = createFileRoute("/_app/server/$serverId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    if (params.serverId === "unavailable") return { instance: null }

    const connection = await context.queryClient.ensureQueryData(
      relayConnectionQueryOptions(context.queryClient)
    )
    const snapshot =
      connection.status === "connected"
        ? connection.snapshot
        : await context.queryClient.ensureQueryData(relaySnapshotQueryOptions())

    const resolution = resolveRelayInstance(snapshot.instances, params.serverId)
    if (resolution.status === "ambiguous") {
      throw redirectToServerList(params.serverId)
    }
    if (resolution.status === "not-found") {
      throw redirect({ to: "/infra/servers", replace: true })
    }
    const instance = resolution.instance
    const routeIdentifier = relayInstanceRouteIdentifier(
      snapshot.instances,
      instance
    )
    if (!routeIdentifier) {
      throw redirectToServerList(instance.shortId)
    }

    // Relay-qualified links are already unambiguous. Rewriting one while its
    // client transition is resolving can start a second transition for the
    // same instance and lock the router.
    const alreadyRelayQualified = params.serverId === instance.routeId
    if (!alreadyRelayQualified && params.serverId !== routeIdentifier) {
      const segments = location.pathname.split("/")
      segments[2] = encodeURIComponent(routeIdentifier)
      throw redirect({
        href: `${segments.join("/")}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
        replace: true,
      })
    }
    return {
      instance: {
        brickId: instance.brickId,
        id: instance.id,
        relayId: instance.relayId,
      },
    }
  },
  component: Outlet,
})

function redirectToServerList(shortId: string) {
  return redirect({
    href: `/infra/servers?search=${encodeURIComponent(shortId)}`,
    replace: true,
  })
}
