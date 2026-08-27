import { DbClient } from "@tanstack/db"
import { QueryClient } from "@tanstack/react-query"
import type { AnyRouter } from "@tanstack/react-router"

export interface AppRouterContext {
  dbClient: DbClient
  queryClient: QueryClient
}

export type RouterSsrCleanupLifecycle = Pick<
  AnyRouter,
  "isServer" | "serverSsr" | "serverSsrLifecycle"
>

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        gcTime: 10 * 60_000,
        retry: 1,
        staleTime: 5_000,
      },
    },
  })
}

export function createAppClients(): AppRouterContext {
  const queryClient = createAppQueryClient()
  return {
    dbClient: new DbClient({ queryClient }),
    queryClient,
  }
}

export function registerDbClientSsrCleanup(
  router: RouterSsrCleanupLifecycle,
  dbClient: Pick<DbClient, "cleanup">
): void {
  if (!router.isServer) return
  const registerCleanup = (serverSsr: NonNullable<AnyRouter["serverSsr"]>) => {
    serverSsr.onCleanup(() => {
      void dbClient.cleanup()
    })
  }
  router.serverSsrLifecycle = {
    ...router.serverSsrLifecycle,
    onServerSsrAttach: [
      ...(router.serverSsrLifecycle?.onServerSsrAttach ?? []),
      registerCleanup,
    ],
  }
}
