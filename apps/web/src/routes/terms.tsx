import { createFileRoute } from "@tanstack/react-router"

import { redirectToMarketing } from "@/lib/marketing-url"

export const Route = createFileRoute("/terms")({
  loader: () => redirectToMarketing("/terms"),
})
