import { ResourceInvitationDialog } from "@/components/resource-invitation-dialog"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { invitationInfrastructureHref } from "@/lib/resource-invitation-query"
import { getResourceInvitation } from "@/server/resource-access"
import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { InvitationPage } from "@/components/invitation-page"
import { recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { invitePath } from "@/lib/invitation-auth"
import { pageTitle } from "@/lib/page-title"
import { invitationPreviewQueryOptions } from "@/lib/query-options"
import { getInvitationPreview } from "@/server/access"
import { getAuthState } from "@/server/auth"

const invitationSearchSchema = z.object({
  id: z.uuid().optional(),
  token: z.preprocess(
    (value) =>
      typeof value === "string" && value.length >= 32 && value.length <= 256
        ? value
        : undefined,
    z.string().min(32).max(256).optional()
  ),
})

export const Route = createFileRoute("/invite")({
  validateSearch: invitationSearchSchema,
  loaderDeps: ({ search }) => ({ token: search.token }),
  beforeLoad: async ({ search }) => {
    const state = await getAuthState()
    const token = search.token
    if (search.id) {
      if (!state.user)
        throw redirect({
          to: "/",
          search: { redirect: `/invite?id=${encodeURIComponent(search.id)}` },
        })
      if (!isAccountEnabled(state.user) || !isAccountVerified(state.user))
        throw redirect({
          to: "/account-status",
          search: { redirect: `/invite?id=${encodeURIComponent(search.id)}` },
        })
      const invitation = await recoverPromise(
        () => getResourceInvitation({ data: { id: search.id! } }),
        () => null
      )
      // Let the invitation dialog show its unavailable/error state and close
      // action when this account cannot load the invitation.
      if (invitation?.pending)
        throw redirect({
          href: invitationInfrastructureHref(invitation),
          replace: true,
        })
      return state
    }
    if (!token) return state
    if (state.user) {
      if (!isAccountEnabled(state.user) || !isAccountVerified(state.user))
        throw redirect({
          to: "/account-status",
          search: { redirect: invitePath(token) },
        })
      const scoped = await recoverPromise(
        () => getResourceInvitation({ data: { token } }),
        () => null
      )
      if (scoped)
        throw redirect({
          href: scoped.pending
            ? invitationInfrastructureHref(scoped)
            : `/invite?id=${encodeURIComponent(scoped.id)}`,
          replace: true,
        })
      return state
    }
    const preview = await recoverPromise(
      () => getInvitationPreview({ data: { token } }),
      () => null
    )
    if (!preview) return state
    throw redirect({
      to: "/",
      search: {
        email: preview.email,
        redirect: invitePath(token),
      },
    })
  },
  loader: ({ context, deps }) =>
    deps.token
      ? context.queryClient.ensureQueryData(
          invitationPreviewQueryOptions(deps.token)
        )
      : null,
  head: () => ({ meta: [{ title: pageTitle("Invitation") }] }),
  component: InviteRoute,
})

function InviteRoute() {
  const { token, id } = Route.useSearch()
  const { user } = Route.useRouteContext()
  if (id && user)
    return (
      <ResourceInvitationDialog
        invitationId={id}
        onClose={() => window.location.assign("/")}
      />
    )
  if (!token) {
    return <InvitationPage preview={null} token="" user={user} />
  }
  return <InvitationWithToken token={token} user={user} />
}

function InvitationWithToken({
  token,
  user,
}: {
  token: string
  user: AuthenticatedUser | null
}) {
  const { data: preview } = useSuspenseQuery(
    invitationPreviewQueryOptions(token)
  )
  return <InvitationPage preview={preview} token={token} user={user} />
}
