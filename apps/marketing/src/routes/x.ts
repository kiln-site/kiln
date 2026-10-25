import { createFileRoute } from "@tanstack/react-router"

import { redirectToSocial } from "@/lib/social-links"

export const Route = createFileRoute("/x")({
  beforeLoad: () => redirectToSocial("x"),
})
