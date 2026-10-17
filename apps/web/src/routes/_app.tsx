import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { AppNotFoundPage } from "@/components/app-error-page"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  authStateQueryOptions,
  instanceFavoritesQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaysQueryOptions,
  serverDirectoryQueryOptions,
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
    if (!isAccountEnabled(user) || !isAccountVerified(user)) {
      throw redirect({
        to: "/account-status",
        search: { redirect: location.href },
      })
    }
    await context.queryClient.ensureQueryData(accessCapabilitiesQueryOptions())
    return { user }
  },
  // The sidebar and command menu list and count what the user can reach
  // from Hearth's own records. Load them with the frame so it renders
  // complete in the first HTML, without asking any Relay.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(uiPreferencesQueryOptions()),
      context.queryClient.ensureQueryData(serverDirectoryQueryOptions()),
      context.queryClient.ensureQueryData(appDirectoryQueryOptions()),
      context.queryClient.ensureQueryData(
        managedDatabaseDirectoryQueryOptions()
      ),
      context.queryClient.ensureQueryData(relaysQueryOptions()),
      // Stars render with their rows instead of popping in afterwards.
      context.queryClient.ensureQueryData(instanceFavoritesQueryOptions()),
    ])
  },
  component: AuthenticatedApp,
  notFoundComponent: AppNotFoundPage,
})

function AuthenticatedApp() {
  return <Outlet />
}
