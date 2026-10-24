import { createFileRoute } from "@tanstack/react-router"

import { KilnViewerPage } from "@/components/kiln/kiln-viewer-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/kiln/viewer")({
  component: KilnViewerPage,
  head: () => ({ meta: [{ title: pageTitle("Kiln Viewer") }] }),
})
