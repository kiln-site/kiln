import { createFileRoute } from "@tanstack/react-router"

import { KilnOperationsPage } from "@/components/kiln/kiln-operations-page"
import { operationsOverviewQueryOptions } from "@/lib/operations-queries"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/kiln/operations")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(operationsOverviewQueryOptions()),
  component: KilnOperationsPage,
  head: () => ({ meta: [{ title: pageTitle("Kiln Operations") }] }),
})
