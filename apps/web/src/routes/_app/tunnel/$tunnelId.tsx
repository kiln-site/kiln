import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import {
  selectTunnel,
  tunnelPermissionsOf,
} from "@/components/tunnel/tunnel-data"
import { tunnelsQueryOptions } from "@/lib/query-options"

export const Route = createFileRoute("/_app/tunnel/$tunnelId")({
  staleTime: Infinity,
  beforeLoad: async ({ context, params }) => {
    const tunnels = await context.queryClient.ensureQueryData(
      tunnelsQueryOptions()
    )
    // A tunnel added moments ago may not be in the cached list yet.
    const tunnel =
      selectTunnel(tunnels, params.tunnelId) ??
      selectTunnel(
        await context.queryClient.fetchQuery({
          ...tunnelsQueryOptions(),
          staleTime: 0,
        }),
        params.tunnelId
      )
    if (!tunnel) throw redirect({ to: "/infra/tunnels", replace: true })
    return {
      tunnel: { id: tunnel.id, permissions: tunnelPermissionsOf(tunnel) },
    }
  },
  component: Outlet,
})
