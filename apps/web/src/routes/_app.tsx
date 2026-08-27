import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { AppNotFoundPage } from "@/components/app-error-page"
import {
  accessCapabilitiesQueryOptions,
  authStateQueryOptions,
  relayConnectionQueryOptions,
  uiPreferencesQueryOptions,
} from "@/lib/query-options"

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  beforeLoad: async ({ context, location }) => {
    const { user } = await context.queryClient.ensureQueryData(
      authStateQueryOptions()
    )
    if (!user) {
      throw redirect({
        to: "/",
        search: { redirect: location.href },
      })
    }
    await context.queryClient.ensureQueryData(accessCapabilitiesQueryOptions())
    return { user }
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        relayConnectionQueryOptions(context.queryClient)
      ),
      context.queryClient.ensureQueryData(uiPreferencesQueryOptions()),
    ])
  },
  component: AuthenticatedApp,
  notFoundComponent: AppNotFoundPage,
})

function AuthenticatedApp() {
  return <Outlet />
}
