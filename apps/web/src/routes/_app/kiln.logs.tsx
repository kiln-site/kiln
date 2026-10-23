import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { KilnLogsPage } from "@/components/kiln/kiln-logs-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/kiln/logs")({
  validateSearch: z.object({
    // Kiln's container; the page falls back to the first for others.
    service: z.string().max(16).optional(),
  }),
  component: KilnLogsPage,
  head: () => ({ meta: [{ title: pageTitle("Kiln Logs") }] }),
})
