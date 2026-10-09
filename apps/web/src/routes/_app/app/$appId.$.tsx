import { createFileRoute } from "@tanstack/react-router"

import { AppNotFoundPage } from "@/components/app-error-page"

export const Route = createFileRoute("/_app/app/$appId/$")({
  component: AppNotFoundPage,
})
