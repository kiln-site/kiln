import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { NotFoundPage } from "~/components/not-found-page"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFoundPage,
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
