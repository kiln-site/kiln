import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import {
  databaseRouteIdentifier,
  resolveDatabaseRoute,
} from "@/lib/database-route"
import { managedDatabaseDirectoryQueryOptions } from "@/lib/query-options"
import {
  invitationInfrastructureHref,
  myInvitationsQueryOptions,
} from "@/lib/resource-invitation-query"

export const Route = createFileRoute("/_app/db/$databaseId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    let databases = await context.queryClient.ensureQueryData(
      managedDatabaseDirectoryQueryOptions()
    )
    let resolution = resolveDatabaseRoute(databases, params.databaseId)
    if (resolution.status === "not-found") {
      // A database created moments ago may not be in the cached directory yet.
      databases = await context.queryClient.fetchQuery({
        ...managedDatabaseDirectoryQueryOptions(),
        staleTime: 0,
      })
      resolution = resolveDatabaseRoute(databases, params.databaseId)
    }
    if (resolution.status === "ambiguous") {
      throw redirectToDatabaseList(params.databaseId)
    }
    if (resolution.status === "not-found") {
      const invitations = await context.queryClient.ensureQueryData(
        myInvitationsQueryOptions()
      )
      const matches = invitations.filter(
        (invitation) =>
          invitation.scope.resourceType === "database" &&
          (invitation.scope.resourceId === params.databaseId ||
            invitation.scope.resourceId.slice(0, 8) === params.databaseId)
      )
      if (matches.length === 1) {
        throw redirect({
          href: invitationInfrastructureHref(matches[0]!),
          replace: true,
        })
      }
      throw redirect({ to: "/infra/databases", replace: true })
    }
    const database = resolution.database
    const routeIdentifier = databaseRouteIdentifier(databases, database)
    if (params.databaseId !== routeIdentifier) {
      const segments = location.pathname.split("/")
      segments[2] = encodeURIComponent(routeIdentifier)
      throw redirect({
        href: `${segments.join("/")}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
        replace: true,
      })
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

function redirectToDatabaseList(search: string) {
  return redirect({
    href: `/infra/databases?search=${encodeURIComponent(search)}`,
    replace: true,
  })
}
