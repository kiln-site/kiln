import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_app/kiln/")({
  beforeLoad: () => {
    throw redirect({ to: "/kiln/info", replace: true })
  },
})
