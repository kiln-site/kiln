import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TailscalePage } from "@/components/tailscale-page"
import { pageTitle } from "@/lib/page-title"
import {
  relaysQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/tailscale")({
  validateSearch: z.object({
    create: z.boolean().optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/tailscale"
    )
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(relaysQueryOptions()),
      context.queryClient.ensureQueryData(tailscaleStacksQueryOptions()),
    ]),
  head: () => ({ meta: [{ title: pageTitle("Tailscale") }] }),
  component: TailscaleRoute,
})

function TailscaleRoute() {
  const { create = false } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <TailscalePage
      createOpen={create}
      onCreateOpenChange={(open) => {
        void navigate({
          replace: !open,
          search: open ? { create: true } : {},
        })
      }}
    />
  )
}
