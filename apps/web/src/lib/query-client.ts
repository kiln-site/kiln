import { DbClient } from "@tanstack/db"
import { QueryClient } from "@tanstack/react-query"

import { RenderReadError } from "@/effect/errors"

export interface AppRouterContext {
  dbClient: DbClient
  queryClient: QueryClient
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // A read that failed while Hearth rendered the page reaches the browser
      // with its message; anything else streamed that fails is redacted.
      dehydrate: {
        shouldRedactErrors: (error) => !(error instanceof RenderReadError),
      },
      // A read the server started while rendering and that failed there has
      // used its first try; the browser retries it at once.
      hydrate: {
        queries: {
          retryDelay: 0,
        },
      },
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
