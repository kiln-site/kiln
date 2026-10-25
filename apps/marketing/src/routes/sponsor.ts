import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/sponsor")({
  beforeLoad: () => {
    throw redirect({ href: "https://github.com/sponsors/kiln-site" })
  },
})
