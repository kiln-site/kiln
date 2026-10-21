import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { NotFoundPage } from "~/components/not-found-page"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Links to a section on the page glide to it. Arriving at one, by a
    // refresh, a new tab, or back, still jumps straight there.
    defaultHashScrollIntoView: prefersReducedMotion()
      ? true
      : { behavior: "smooth" },
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFoundPage,
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
