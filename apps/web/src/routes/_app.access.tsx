import { createFileRoute } from "@tanstack/react-router"
import { AccessPage } from "@/components/access-page"
import { pageTitle } from "@/lib/page-title"
import { requireGlobalDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/access")({
  beforeLoad: async ({ context }) => {
    await requireGlobalDestinationAccess(context.queryClient, "access")
  },
  head: () => ({ meta: [{ title: pageTitle("Access") }] }),
  component: AccessPage,
})
