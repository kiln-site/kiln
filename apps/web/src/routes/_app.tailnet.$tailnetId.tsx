import { createFileRoute } from "@tanstack/react-router"

import { TailnetPage } from "@/components/tunnel/tailnet-page"
import { pageTitle } from "@/lib/page-title"
import { tailnetsQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/tailnet/$tailnetId")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/tunnels"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(tailnetsQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Tailnet") }] }),
  component: TailnetRoute,
})

function TailnetRoute() {
  const { tailnetId } = Route.useParams()
  return <TailnetPage tailnetId={tailnetId} />
}
