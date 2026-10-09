import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/app/$appId/files/$")({
  pendingMinMs: 0,
})
