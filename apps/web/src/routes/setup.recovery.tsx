import { createFileRoute, redirect } from "@tanstack/react-router"

import { RecoveryKitStep } from "@/components/recovery-kit/recovery-kit-step"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { pageTitle } from "@/lib/page-title"
import {
  accessCapabilitiesQueryOptions,
  recoveryKitStatusQueryOptions,
} from "@/lib/query-options"
import { getAuthState } from "@/server/auth"

// Saving Kiln's recovery kit, right after the first administrator is made,
// and for any platform administrator while nobody has saved it.
export const Route = createFileRoute("/setup/recovery")({
  beforeLoad: async ({ context, location }) => {
    // Asked afresh: setup signs in without reloading the page, so what was
    // cached before then describes no one.
    const { user } = await getAuthState()
    if (!user) {
      throw redirect({ to: "/", search: { redirect: location.href } })
    }
    if (!isAccountEnabled(user) || !isAccountVerified(user)) {
      throw redirect({
        to: "/account-status",
        search: { redirect: location.href },
      })
    }
    const capabilities = await context.queryClient.fetchQuery({
      ...accessCapabilitiesQueryOptions(),
      staleTime: 0,
    })
    if (!capabilities.isPlatformAdmin) throw redirect({ to: "/" })
    return { user }
  },
  loader: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({
      ...recoveryKitStatusQueryOptions(),
      staleTime: 0,
    })
    if (status.saved) {
      throw redirect({ to: "/kiln/security", hash: "recovery-kit" })
    }
  },
  head: () => ({ meta: [{ title: pageTitle("Save Your Recovery Kit") }] }),
  component: RecoveryKitStep,
})
