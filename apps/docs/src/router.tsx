import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { NotFound } from "~/components/not-found"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Links to a heading glide to it. Arriving at one, by a refresh, a new
    // tab, or back, still jumps straight there.
    defaultHashScrollIntoView: prefersReducedMotion()
      ? true
      : { behavior: "smooth" },
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
  })
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
