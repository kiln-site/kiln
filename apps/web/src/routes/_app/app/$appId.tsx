import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { appRouteIdentifier, resolveAppRoute } from "@/lib/app-route"
import { appDirectoryQueryOptions } from "@/lib/query-options"

export const Route = createFileRoute("/_app/app/$appId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location, params }) => {
    let apps = await context.queryClient.ensureQueryData(
      appDirectoryQueryOptions()
    )
    let resolution = resolveAppRoute(apps, params.appId)
    if (resolution.status === "not-found") {
      // An app created moments ago may not be in the cached directory yet.
      apps = await context.queryClient.fetchQuery({
        ...appDirectoryQueryOptions(),
        staleTime: 0,
      })
      resolution = resolveAppRoute(apps, params.appId)
    }
    if (resolution.status !== "found") {
      throw redirect({
        href: `/infra/apps?search=${encodeURIComponent(params.appId)}`,
        replace: true,
      })
    }
    const app = resolution.database
    const routeIdentifier = appRouteIdentifier(apps, app)
    if (params.appId !== routeIdentifier) {
      const segments = location.pathname.split("/")
      segments[2] = encodeURIComponent(routeIdentifier)
      throw redirect({
        href: `${segments.join("/")}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
        replace: true,
      })
    }
    return { app: { id: app.id, relayId: app.relayId } }
  },
  component: Outlet,
})
