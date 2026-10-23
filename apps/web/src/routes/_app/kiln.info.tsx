import { createFileRoute } from "@tanstack/react-router"

import { KilnInfoPage } from "@/components/kiln/kiln-info-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/kiln/info")({
  component: KilnInfoPage,
  head: () => ({ meta: [{ title: pageTitle("Kiln") }] }),
})
