import * as Sentry from "@sentry/tanstackstart-react"
import { DbProvider } from "@tanstack/react-db"
import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"

import {
  AppNotFoundPage,
  AppRouterErrorBoundary,
} from "@/components/app-error-page"
import {
  createAppClients,
  registerDbClientSsrCleanup,
} from "@/lib/query-client"
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
    Wrap: ({ children }) => (
      <DbProvider client={dbClient}>{children}</DbProvider>
    ),
  })

  setupRouterSsrQueryIntegration({ queryClient, router })
  registerDbClientSsrCleanup(router, dbClient)

  if (!router.isServer && Sentry.isInitialized()) {
    Sentry.addIntegration(
      Sentry.tanstackRouterBrowserTracingIntegration(router)
    )
  }

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
