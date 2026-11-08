import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { appDirectoryQueryOptions } from "@/lib/query-options"
import { renderRead } from "@/lib/render-reads"

export const Route = createFileRoute("/_app/app/$appId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
    const apps = await context.queryClient.ensureQueryData(
      appDirectoryQueryOptions()
    )
    // An app created moments ago may not be in the cached directory yet.
    const app =
      apps.find((candidate) => candidate.id === params.appId) ??
      (
        await context.queryClient.fetchQuery({
          ...appDirectoryQueryOptions(),
          staleTime: 0,
        })
      ).find((candidate) => candidate.id === params.appId)
    if (!app) throw redirect({ to: "/infra/apps", replace: true })
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
