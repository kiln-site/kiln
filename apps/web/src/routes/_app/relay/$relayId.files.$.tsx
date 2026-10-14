import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/relay/$relayId/files/$")({
  pendingMinMs: 0,
})
