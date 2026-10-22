import { createFileRoute } from "@tanstack/react-router"

import { redirectToLegalPage } from "@/lib/legal-urls"

export const Route = createFileRoute("/privacy")({
  loader: () => redirectToLegalPage("privacy"),
})
