import { Outlet, createFileRoute } from "@tanstack/react-router"

import { kilnPlatformQueryOptions } from "@/lib/query-options"
import { requireKilnAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/kiln")({
  beforeLoad: async ({ context }) => {
    await requireKilnAccess(context.queryClient)
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(kilnPlatformQueryOptions()),
  component: Outlet,
})
