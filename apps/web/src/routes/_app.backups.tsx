import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { BackupsRouteOutlet } from "@/components/backups-layout"
import { requireGlobalDestinationAccess } from "@/lib/route-access"

const backupSearchSchema = z.object({
  kind: z.enum(["database", "relay", "server"]).optional(),
  relay: z.string().max(120).optional(),
  search: z.string().max(160).optional(),
  server: z.string().max(120).optional(),
  status: z.enum(["available", "active", "failed"]).optional(),
})

export const Route = createFileRoute("/_app/backups")({
  validateSearch: backupSearchSchema,
  beforeLoad: async ({ context }) => {
    await requireGlobalDestinationAccess(context.queryClient, "backups")
  },
  component: BackupsRouteOutlet,
})
