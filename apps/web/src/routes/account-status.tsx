import { z } from "zod"
import { accountReturnPath } from "@/lib/account-return-path"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { AccountStatusPage } from "@/components/account-status-page"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { pageTitle } from "@/lib/page-title"
import { getAuthState } from "@/server/auth"

export const Route = createFileRoute("/account-status")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    const state = await getAuthState()
    if (!state.user) throw redirect({ to: "/" })
    if (isAccountEnabled(state.user) && isAccountVerified(state.user))
      throw redirect({ href: accountReturnPath(search.redirect) })
    return {
      user: state.user,
      emailDeliveryEnabled: state.emailDeliveryEnabled,
    }
  },
  head: () => ({ meta: [{ title: pageTitle("Account Status") }] }),
  component: AccountStatusRoute,
})
function AccountStatusRoute() {
  const { user, emailDeliveryEnabled } = Route.useRouteContext()
  const resumePath = accountReturnPath(Route.useSearch().redirect)
  return (
    <AccountStatusPage
      user={user}
      emailDeliveryEnabled={emailDeliveryEnabled}
      resumePath={resumePath}
    />
  )
}
