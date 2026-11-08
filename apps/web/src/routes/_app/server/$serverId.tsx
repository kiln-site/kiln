import {
  myInvitationsQueryOptions,
  invitationInfrastructureHref,
} from "@/lib/resource-invitation-query"
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

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

// A game server's page is named by its instance ID alone. Instance IDs are
// unique across every Relay, so the route finds the server wherever it runs.
export const Route = createFileRoute("/_app/server/$serverId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
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

    // A server this page already knows, opened for the first time, opens at
    // once: the page reads its own server in the background, and the route
    // resolves again if that read disagrees.
    const known =
      queryClient.getQueryData(
        serverWorkspaceQueryOptions(params.serverId).queryKey
      ) === undefined
        ? knownServer(queryClient, params.serverId)
        : undefined
    if (known) {
      forkPromise(() => ensureServerWorkspace(queryClient, params.serverId))
      if (navigation) forkPromise(() => navigation)
      return { ...openedServer(known), serverVerified: false }
    }

    const [workspace] = await Promise.all([
      ensureServerWorkspace(queryClient, params.serverId),
      navigation,
    ])

    if (workspace.status === "not-found") {
      const invitations = await queryClient.ensureQueryData(
        myInvitationsQueryOptions()
      )
      const invitation = invitations.find(
        (candidate) =>
          candidate.scope.resourceType === "server" &&
          candidate.scope.resourceId === params.serverId
      )
      if (invitation)
        throw redirect({
          href: invitationInfrastructureHref(invitation),
          replace: true,
        })

      throw redirect({ to: "/infra/servers", replace: true })
    }
    const [instance] = workspace.snapshot.instances
    if (!instance) throw redirect({ to: "/infra/servers", replace: true })
    return { ...openedServer(instance), serverVerified: true }
  },
  component: Outlet,
})

function openedServer(
  server: Pick<KnownServer, "id" | "relayId"> &
    Partial<Pick<KnownServer, "brickId">>
) {
  return {
    instance: {
      brickId: server.brickId,
      id: server.id,
      relayId: server.relayId,
    },
  }
}
