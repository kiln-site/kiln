import {
  myInvitationsQueryOptions,
  invitationInfrastructureHref,
} from "@/lib/resource-invitation-query"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import {
  Outlet,
  createFileRoute,
  redirect,
  type ParsedLocation,
} from "@tanstack/react-router"

import {
  serverDirectoryQueryOptions,
  serverNavigationQueryOptions,
} from "@/lib/query-options"
import { forkPromise } from "@/effect/promise"
import {
  ensureServerWorkspace,
  knownServer,
  serverWorkspaceQueryOptions,
  type KnownServer,
} from "@/lib/server-workspace"

export const Route = createFileRoute("/_app/server/$serverId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    if (params.serverId === "unavailable")
      return { instance: null, serverVerified: true }
    const { queryClient } = context

    // The sidebar opens this server too; load its entry with the route so it
    // never shows the previous one. A loaded directory already answers it.
    const directoryLoaded =
      queryClient.getQueryData(serverDirectoryQueryOptions().queryKey) !==
      undefined
    const navigation = directoryLoaded
      ? undefined
      : queryClient.ensureQueryData(
          serverNavigationQueryOptions({ serverId: params.serverId })
        )

    // A server this page already knows, opened for the first time by its
    // canonical ID, opens at once: the page reads its own server in the
    // background, and the route resolves again if that read disagrees. A link
    // that would redirect waits for Hearth's answer, since a cached one may
    // send it to the wrong server.
    const known =
      queryClient.getQueryData(
        serverWorkspaceQueryOptions(params.serverId).queryKey
      ) === undefined
        ? knownServer(queryClient, params.serverId)
        : undefined
    if (
      known &&
      (params.serverId === known.routeIdentifier ||
        params.serverId === known.server.routeId)
    ) {
      forkPromise(() => ensureServerWorkspace(queryClient, params.serverId))
      if (navigation) forkPromise(() => navigation)
      return {
        ...openedServer(
          location,
          params.serverId,
          known.server,
          known.routeIdentifier
        ),
        serverVerified: false,
      }
    }

    const [workspace] = await Promise.all([
      ensureServerWorkspace(queryClient, params.serverId),
      navigation,
    ])

    if (workspace.status === "ambiguous") {
      throw redirectToServerList(params.serverId)
    }
    if (workspace.status === "not-found") {
      const invitations = await queryClient.ensureQueryData(
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
    const [instance] = workspace.snapshot.instances
    if (!instance) throw redirect({ to: "/infra/servers", replace: true })
    if (!workspace.routeIdentifier) {
      throw redirectToServerList(instance.shortId)
    }
    return {
      ...openedServer(
        location,
        params.serverId,
        instance,
        workspace.routeIdentifier
      ),
      serverVerified: true,
    }
  },
  component: Outlet,
})

// The route's context for a resolved server, after redirecting a link that
// does not use its canonical ID.
function openedServer(
  location: ParsedLocation,
  serverId: string,
  server: Pick<KnownServer, "id" | "relayId" | "routeId"> &
    Partial<Pick<KnownServer, "brickId">>,
  routeIdentifier: string
) {
  // Relay-qualified links are already unambiguous. Rewriting one while its
  // client transition is resolving can start a second transition for the
  // same instance and lock the router.
  const alreadyRelayQualified = serverId === server.routeId
  if (!alreadyRelayQualified && serverId !== routeIdentifier) {
    const segments = location.pathname.split("/")
    segments[2] = encodeURIComponent(routeIdentifier)
    throw redirect({
      href: `${segments.join("/")}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
      replace: true,
    })
  }
  return {
    instance: {
      brickId: server.brickId,
      id: server.id,
      relayId: server.relayId,
    },
  }
}

function redirectToServerList(shortId: string) {
  return redirect({
    href: `/infra/servers?search=${encodeURIComponent(shortId)}`,
    replace: true,
  })
}
