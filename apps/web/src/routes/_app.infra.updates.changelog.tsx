import { createFileRoute } from "@tanstack/react-router"

import { OpenInfraUpdateDialog } from "@/components/infra-update-dialog-provider"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/updates/changelog")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/relays"
    )
  },
  component: InfraUpdatesChangelogRoute,
})

function InfraUpdatesChangelogRoute() {
  return <OpenInfraUpdateDialog view="changelog" />
}
