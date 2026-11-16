import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { selectTunnel } from "@/components/tunnel/tailnet-data"
import { tailnetsQueryOptions } from "@/lib/query-options"

export const Route = createFileRoute("/_app/tunnel/$tunnelId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
    const tailnets = await context.queryClient.ensureQueryData(
      tailnetsQueryOptions()
    )
    // A tunnel added moments ago may not be in the cached list yet.
    const view =
      selectTunnel(tailnets, params.tunnelId) ??
      selectTunnel(
        await context.queryClient.fetchQuery({
          ...tailnetsQueryOptions(),
          staleTime: 0,
        }),
        params.tunnelId
      )
    if (!view) throw redirect({ to: "/infra/tunnels", replace: true })
    return { tunnel: { id: view.tunnel.id, permissions: view.permissions } }
  },
  component: Outlet,
})
