import { createFileRoute } from "@tanstack/react-router"

import { KilnPlatformPage } from "@/components/kiln-platform-page"
import { pageTitle } from "@/lib/page-title"
import { kilnPlatformQueryOptions } from "@/lib/query-options"
import { requireInfrastructureDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/platform")({
  beforeLoad: async ({ context }) => {
    await requireInfrastructureDestinationAccess(
      context.queryClient,
      "/infra/platform"
    )
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(kilnPlatformQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("System") }] }),
  component: KilnPlatformPage,
})
