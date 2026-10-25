import { createFileRoute } from "@tanstack/react-router"

import { redirectToSocial } from "@/lib/social-links"

export const Route = createFileRoute("/discord")({
  beforeLoad: () => redirectToSocial("discord"),
})
