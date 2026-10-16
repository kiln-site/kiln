import { createFileRoute, redirect } from "@tanstack/react-router"

// The Proxy page is now part of Info; old links land there.
export const Route = createFileRoute("/_app/relay/$relayId/proxy")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/relay/$relayId/info", params, replace: true })
  },
})
