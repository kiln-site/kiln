import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import {
  invitationInfrastructureHref,
  myInvitationsQueryOptions,
} from "@/lib/resource-invitation-query"

export const Route = createFileRoute("/_app/db/$databaseId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
    const databases = await context.queryClient.ensureQueryData(
      managedDatabaseDirectoryQueryOptions()
    )
    // A database created moments ago may not be in the cached directory yet.
    const database =
      databases.find((candidate) => candidate.id === params.databaseId) ??
      (
        await context.queryClient.fetchQuery({
          ...managedDatabaseDirectoryQueryOptions(),
          staleTime: 0,
        })
      ).find((candidate) => candidate.id === params.databaseId)
    if (!database) {
      const invitations = await context.queryClient.ensureQueryData(
        myInvitationsQueryOptions()
      )
      const invitation = invitations.find(
        (candidate) =>
          candidate.scope.resourceType === "database" &&
          candidate.scope.resourceId === params.databaseId
      )
      if (invitation) {
        throw redirect({
          href: invitationInfrastructureHref(invitation),
          replace: true,
        })
      }
      throw redirect({ to: "/infra/databases", replace: true })
    }
    return {
      database: {
        engine: database.engine,
        id: database.id,
        relayId: database.relayId,
      },
    }
  },
  component: Outlet,
})
