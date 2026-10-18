import { createFileRoute } from "@tanstack/react-router"
import { LayoutDashboard } from "lucide-react"

import { SettingsPlaceholderPage } from "@/components/settings-placeholder-page"
import { pageTitle } from "@/lib/page-title"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/overview")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/overview"
    )
  },
  head: () => ({ meta: [{ title: pageTitle("Infrastructure Overview") }] }),
  component: InfraOverviewRoute,
})

function InfraOverviewRoute() {
  return (
    <SettingsPlaceholderPage
      title="Overview"
      description="A summary of your infrastructure and connection checks will live here."
      icon={LayoutDashboard}
    />
  )
}
