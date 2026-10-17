import {
  myInvitationsQueryOptions,
  invitationInfrastructureHref,
} from "@/lib/resource-invitation-query"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import {
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
  serverDirectoryQueryOptions,
  serverNavigationQueryOptions,
} from "@/lib/query-options"
import {
  relayInstanceRouteIdentifier,
  resolveRelayInstance,
} from "@/lib/relay-selectors"

export const Route = createFileRoute("/_app/server/$serverId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    if (params.serverId === "unavailable") return { instance: null }

    // The sidebar opens this server; load its entry with the route so it
    // never shows the previous one. A loaded directory already answers it.
    const directoryLoaded =
      context.queryClient.getQueryData(
        serverDirectoryQueryOptions().queryKey
      ) !== undefined
    const [connection] = await Promise.all([
      context.queryClient.ensureQueryData(
        relayConnectionQueryOptions(context.queryClient)
      ),
      directoryLoaded
        ? undefined
        : context.queryClient.ensureQueryData(
            serverNavigationQueryOptions({ serverId: params.serverId })
          ),
    ])
    const snapshot =
      connection.status === "connected"
        ? connection.snapshot
        : await context.queryClient.ensureQueryData(relaySnapshotQueryOptions())

    const resolution = resolveRelayInstance(snapshot.instances, params.serverId)
    if (resolution.status === "ambiguous") {
      throw redirectToServerList(params.serverId)
    }
    if (resolution.status === "not-found") {
      const invitations = await context.queryClient.ensureQueryData(
        myInvitationsQueryOptions()
      )
      const matches = invitations.filter(
        (invitation) =>
          invitation.scope.resourceType === "instance" &&
          (invitation.scope.resourceId === params.serverId ||
            invitation.scope.resourceId.slice(0, 8) === params.serverId ||
            relayInstanceRouteId(
              invitation.scope.relayId,
              invitation.scope.resourceId.slice(0, 8)
            ) === params.serverId)
      )
      if (matches.length === 1)
        throw redirect({
          href: invitationInfrastructureHref(matches[0]!),
          replace: true,
        })

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
