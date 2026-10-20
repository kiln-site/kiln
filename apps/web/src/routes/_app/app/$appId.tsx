import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { appRouteIdentifier, resolveAppRoute } from "@/lib/app-route"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { appDirectoryQueryOptions } from "@/lib/query-options"
import { renderRead } from "@/lib/render-reads"

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
    const app = resolution.resource
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
  loader: ({ context }) => {
    const { app, queryClient } = context
    // Every app page opens once it has the app's details, so they start with
    // the navigation, and stream in while Hearth renders the page.
    void queryClient.prefetchQuery(
      renderRead(
        "app",
        instanceInventoryQueryOptions(
          { kind: "app", id: app.id, relayId: app.relayId },
          "detail"
        )
      )
    )
  },
  component: Outlet,
})
