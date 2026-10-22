import { createFileRoute, redirect } from "@tanstack/react-router"

import { BrowserAccountsPage } from "@/components/browser-accounts-page"
import { pageTitle } from "@/lib/page-title"
import { getAuthState } from "@/server/auth"
import { getBrowserAccounts } from "@/server/browser-accounts"

export const Route = createFileRoute("/accounts")({
  beforeLoad: async () => {
    const [state, accounts] = await Promise.all([
      getAuthState(),
      getBrowserAccounts(),
    ])
    // The development bypass stands in for every session, so there is no
    // account to choose.
    if (state.user?.isDevelopmentBypass || accounts.length === 0)
      throw redirect({ to: "/" })
    return { accounts }
  },
  head: () => ({ meta: [{ title: pageTitle("Accounts") }] }),
  component: AccountsRoute,
})

function AccountsRoute() {
  const { accounts } = Route.useRouteContext()
  return <BrowserAccountsPage accounts={accounts} />
}
