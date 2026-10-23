import { createFileRoute, redirect } from "@tanstack/react-router"

// Kiln's services moved to their own pages.
export const Route = createFileRoute("/_app/infra/platform")({
  beforeLoad: () => {
    throw redirect({ to: "/kiln/info", replace: true })
  },
})
