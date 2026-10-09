import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"

import { AppNotFoundPage } from "@/components/app-error-page"
import { appRouteIdFromSelection } from "@/lib/app-route"
import { databaseRouteIdFromSelection } from "@/lib/database-route"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  authStateQueryOptions,
  managedDatabaseDirectoryQueryOptions,
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
    if (!isAccountEnabled(user) || !isAccountVerified(user)) {
      throw redirect({
        to: "/account-status",
        search: { redirect: location.href },
      })
    }
    await context.queryClient.ensureQueryData(accessCapabilitiesQueryOptions())
    return { user }
  },
  loader: async ({ context }) => {
    const [, uiPreferences] = await Promise.all([
      context.queryClient.ensureQueryData(
        relayConnectionQueryOptions(context.queryClient)
      ),
      context.queryClient.ensureQueryData(uiPreferencesQueryOptions()),
    ])
    // The sidebar shows a remembered database from the directory; load it
    // with the frame so the sidebar does not switch after hydration.
    if (databaseRouteIdFromSelection(uiPreferences.selectedInstanceRouteId)) {
      await context.queryClient.ensureQueryData(
        managedDatabaseDirectoryQueryOptions()
      )
    }
    if (appRouteIdFromSelection(uiPreferences.selectedInstanceRouteId)) {
      await context.queryClient.ensureQueryData(appDirectoryQueryOptions())
    }
  },
  component: AuthenticatedApp,
  notFoundComponent: AppNotFoundPage,
})

function AuthenticatedApp() {
  return <Outlet />
}
