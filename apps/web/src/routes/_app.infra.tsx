import { createFileRoute } from "@tanstack/react-router"

import { InfraRouteOutlet } from "@/components/infra-layout"
import { requireInfrastructureSectionAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureSectionAccess(context.queryClient)
  },
  component: InfraRouteOutlet,
})
