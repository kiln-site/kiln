import * as Sentry from "@sentry/tanstackstart-react"
import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { routerWithDbClient } from "@tanstack/react-router-with-db"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"

import {
  AppNotFoundPage,
  AppRouterErrorBoundary,
} from "@/components/app-error-page"
import { createAppClients } from "@/lib/query-client"
import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const { dbClient, queryClient } = createAppClients()
  const router = createTanStackRouter({
    routeTree,
    context: { dbClient, queryClient },

    scrollRestoration: true,
    trailingSlash: "preserve",
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultStructuralSharing: true,
    defaultNotFoundComponent: AppNotFoundPage,
    disableGlobalCatchBoundary: true,
    InnerWrap: AppRouterErrorBoundary,
  })

  setupRouterSsrQueryIntegration({ queryClient, router })
  const dbRouter = routerWithDbClient(router, dbClient)

  if (!dbRouter.isServer && Sentry.isInitialized()) {
    Sentry.addIntegration(
      Sentry.tanstackRouterBrowserTracingIntegration(dbRouter)
    )
  }

  return dbRouter
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
