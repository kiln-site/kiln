import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { KilnTerminalPage } from "@/components/kiln/kiln-terminal-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/kiln/terminal")({
  validateSearch: z.object({
    // Kiln's container; the page falls back to the first for others.
    service: z.string().max(16).optional(),
  }),
  component: KilnTerminalPage,
  head: () => ({ meta: [{ title: pageTitle("Kiln Terminal") }] }),
})
