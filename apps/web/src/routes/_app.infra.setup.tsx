import { createFileRoute } from "@tanstack/react-router"
import { Wrench } from "lucide-react"

import { SettingsPlaceholderPage } from "@/components/settings-placeholder-page"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/setup")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/setup"
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Infrastructure Setup") }] }),
  component: InfraSetupRoute,
})

function InfraSetupRoute() {
  return (
    <SettingsPlaceholderPage
      title="Setup"
      description="Guided infrastructure setup and connection checks will live here."
      icon={Wrench}
    />
  )
}
