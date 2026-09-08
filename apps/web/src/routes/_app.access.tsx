import { z } from "zod"
import { createFileRoute } from "@tanstack/react-router"
import { AccessPage } from "@/components/access-page"
import { pageTitle } from "@/lib/page-title"
import { requireGlobalDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/access")({
  validateSearch: z.object({
    tab: z.enum(["users", "presets"]).optional(),
    relayId: z.string().max(64).optional(),
    resourceType: z.enum(["relay", "instance", "database"]).optional(),
    resourceName: z.string().max(256).optional(),
    resourceId: z.string().max(64).optional(),
  }),
  beforeLoad: async ({ context }) => {
    await requireGlobalDestinationAccess(context.queryClient, "access")
  },
  head: () => ({ meta: [{ title: pageTitle("Access") }] }),
  component: AccessPage,
})
