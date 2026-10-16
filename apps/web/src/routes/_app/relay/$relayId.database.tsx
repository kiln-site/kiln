import { createFileRoute, redirect } from "@tanstack/react-router"

// The Database page is gone; the Relay's database opens in Files from Info.
export const Route = createFileRoute("/_app/relay/$relayId/database")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/relay/$relayId/info", params, replace: true })
  },
})
